import { AccountRole } from '@prisma/client';
import httpStatus from 'http-status';

import prisma from '@/client';
import config from '@/config/config';
import logger from '@/config/logger';
import { loadClientWebhookContext, postCrmWebhook } from '@/shared/services/crm-webhook.service';
import { sendPasswordResetOtpEmail } from '@/shared/services/email.service';
import { createOtpChallenge, verifyOtpChallenge } from '@/shared/services/otp.service';
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSessionByRefreshToken,
  rotateSession,
  signPurposeToken,
  verifyPurposeToken,
} from '@/shared/services/token.service';
import ApiError from '@/shared/utils/api-error';
import { compareSecret, hashSecret } from '@/shared/utils/encryption';
import { AuthTokensResponse } from '@/types/response';

const STAFF_ROLES: AccountRole[] = [
  AccountRole.PLATFORM_OWNER,
  AccountRole.FIRM_ADMIN,
  AccountRole.FIRM_TEAM,
];

// Team stays admin-reset-only by design (oversight rule) - Platform Owner,
// Firm Admin, and Client all get self-service OTP-based recovery.
const SELF_PASSWORD_RESET_ROLES: AccountRole[] = [
  AccountRole.PLATFORM_OWNER,
  AccountRole.FIRM_ADMIN,
  AccountRole.FIRM_CLIENT,
];

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

const publicUser = (user: {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  accountRole: AccountRole;
}) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  accountRole: user.accountRole,
});

// ---------------------------------------------------------------------------
// Staff login (Platform Owner / Firm Admin / Firm Team) - shared endpoint
// ---------------------------------------------------------------------------

export const staffLogin = async (email: string, password: string, meta: RequestMeta) => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: {
      memberships: { select: { id: true, firmId: true, isOwner: true, status: true } },
    },
  });

  if (
    !user ||
    !STAFF_ROLES.includes(user.accountRole) ||
    !user.passwordHash ||
    !(await compareSecret(password, user.passwordHash))
  ) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect email or password');
  }

  if (user.status !== 'ACTIVE') {
    throw new ApiError(httpStatus.FORBIDDEN, 'Your account has been deactivated');
  }

  const membership = user.memberships[0];
  if (user.accountRole !== 'PLATFORM_OWNER') {
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ApiError(
        httpStatus.FORBIDDEN,
        'Your account has been deactivated. Contact your firm admin.'
      );
    }
  }

  const tokens = await createSession(user, {
    firmId: membership?.firmId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return { user: publicUser(user), tokens };
};

export const refreshTokens = async (
  refreshToken: string,
  meta: RequestMeta
): Promise<AuthTokensResponse> => {
  return rotateSession(refreshToken, meta);
};

export const logout = async (refreshToken: string): Promise<void> => {
  await revokeSessionByRefreshToken(refreshToken);
};

// ---------------------------------------------------------------------------
// Client login - 3 steps: email -> password -> emailed OTP
// ---------------------------------------------------------------------------

const CLIENT_LOGIN_PURPOSE = 'client_login';

export const clientLoginStart = async (email: string): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, accountRole: true, status: true },
  });

  if (!user || user.accountRole !== 'FIRM_CLIENT') {
    throw new ApiError(httpStatus.NOT_FOUND, 'No account found with this email');
  }
  if (user.status !== 'ACTIVE') {
    throw new ApiError(httpStatus.FORBIDDEN, 'Your account has been deactivated');
  }
};

/** Posts the login code plus the client's firm/contact details to the CRM workflow. */
const sendClientLoginOtpWebhook = async (
  user: { id: string; email: string | null; firstName: string | null; lastName: string | null; phone: string | null },
  code: string,
  expiresInMinutes: number
): Promise<void> => {
  const access = await prisma.clientAccess.findFirst({
    where: { userId: user.id, revokedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { clientId: true },
  });
  const context = access ? await loadClientWebhookContext(access.clientId) : null;

  await postCrmWebhook('client.login_otp', {
    ...(context ?? {}),
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
    },
    code,
    expiresInMinutes,
  });
};

export const clientLoginPassword = async (
  email: string,
  password: string,
  meta: RequestMeta
): Promise<{ loginToken: string; expiresInMinutes: number }> => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (
    !user ||
    user.accountRole !== 'FIRM_CLIENT' ||
    !user.passwordHash ||
    !(await compareSecret(password, user.passwordHash))
  ) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect email or password');
  }
  if (user.status !== 'ACTIVE') {
    throw new ApiError(httpStatus.FORBIDDEN, 'Your account has been deactivated');
  }

  const { challengeId, code, expiresInMinutes } = await createOtpChallenge({
    userId: user.id,
    destination: user.email as string,
    channel: 'EMAIL',
    purpose: 'LOGIN',
    ipAddress: meta.ipAddress,
  });

  // The code email is sent by the GoHighLevel workflow behind this webhook.
  // Fire-and-forget: the challenge is already saved, so login never waits on it.
  void sendClientLoginOtpWebhook(user, code, expiresInMinutes).catch((error) => {
    logger.error('Client login OTP webhook failed: %s', (error as Error).message);
  });

  const loginToken = signPurposeToken(
    { sub: user.id, purpose: CLIENT_LOGIN_PURPOSE, challengeId },
    config.jwt.clientLoginExpirationMinutes
  );

  return { loginToken, expiresInMinutes: config.jwt.clientLoginExpirationMinutes };
};

export const clientVerifyOtp = async (loginToken: string, otp: string, meta: RequestMeta) => {
  const decoded = verifyPurposeToken(loginToken, CLIENT_LOGIN_PURPOSE);
  const challengeId = decoded.challengeId as string;

  await verifyOtpChallenge(challengeId, otp);

  const user = await prisma.user.findUnique({
    where: { id: decoded.sub },
    include: {
      clientAccess: {
        where: { revokedAt: null },
        include: { client: { select: { firmId: true } } },
        take: 1,
      },
    },
  });

  if (!user || user.accountRole !== 'FIRM_CLIENT' || user.status !== 'ACTIVE') {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate');
  }

  const firmId = user.clientAccess[0]?.client.firmId;

  const tokens = await createSession(user, {
    firmId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
  });

  return { user: publicUser(user), tokens };
};

// ---------------------------------------------------------------------------
// Forgot / reset password - OTP-based, for Platform Owner / Firm Admin / Client
// (Team stays admin-reset-only by design - see SELF_PASSWORD_RESET_ROLES)
// ---------------------------------------------------------------------------

const PASSWORD_RESET_PURPOSE = 'password_reset';

export const forgotPassword = async (
  email: string,
  meta: RequestMeta
): Promise<{ resetToken: string; expiresInMinutes: number }> => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, accountRole: true, status: true },
  });

  const eligible =
    !!user && SELF_PASSWORD_RESET_ROLES.includes(user.accountRole) && user.status === 'ACTIVE';

  // Always return a same-shaped response whether or not the account exists -
  // never reveal account existence through this endpoint. For an ineligible
  // account, the token below is signed against a challenge that can never
  // exist, so step 2 fails the same way a wrong OTP would.
  let challengeId = 'invalid';
  if (eligible) {
    const challenge = await createOtpChallenge({
      userId: user!.id,
      destination: user!.email as string,
      channel: 'EMAIL',
      purpose: 'PASSWORD_RESET',
      ipAddress: meta.ipAddress,
    });
    challengeId = challenge.challengeId;
    // Fire-and-forget for the same reason as the login OTP above - don't let
    // SMTP latency hang this request once the challenge is already persisted.
    sendPasswordResetOtpEmail(
      user!.email as string,
      challenge.code,
      challenge.expiresInMinutes
    ).catch((error) => {
      logger.error('Failed to send password reset OTP email: %s', (error as Error).message);
    });
  }

  const resetToken = signPurposeToken(
    { sub: user?.id ?? 'unknown', purpose: PASSWORD_RESET_PURPOSE, challengeId },
    config.jwt.clientLoginExpirationMinutes
  );

  return { resetToken, expiresInMinutes: config.jwt.clientLoginExpirationMinutes };
};

export const resetPassword = async (
  resetToken: string,
  otp: string,
  newPassword: string
): Promise<void> => {
  const decoded = verifyPurposeToken(resetToken, PASSWORD_RESET_PURPOSE);
  const challengeId = decoded.challengeId as string;

  await verifyOtpChallenge(challengeId, otp);

  const userId = decoded.sub;
  const passwordHash = await hashSecret(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await revokeAllSessionsForUser(userId);
};
