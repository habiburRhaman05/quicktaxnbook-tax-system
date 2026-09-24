import { MemberStatus, StaffType } from '@prisma/client';
import httpStatus from 'http-status';

import prisma, { TX_OPTIONS } from '@/client';
import logger from '@/config/logger';
import { GhlApiError } from '@/modules/ghl/ghl.client';
import {
  createLocationUser,
  fetchLocation,
  listLocationUsers,
} from '@/modules/ghl/ghl.service';
import { ghlTokenProvider } from '@/modules/ghl/ghl.tokens';
import type { GhlUser } from '@/modules/ghl/ghl.types';
import { revokeAllSessionsForUser } from '@/shared/services/token.service';
import ApiError from '@/shared/utils/api-error';
import { generateRandomPassword, hashSecret } from '@/shared/utils/encryption';

const MEMBER_SELECT = {
  id: true,
  staffType: true,
  title: true,
  status: true,
  isOwner: true,
  joinedAt: true,
  deactivatedAt: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      status: true,
      lastLoginAt: true,
    },
  },
} as const;

const assertFirmMember = async (firmId: string, memberId: string) => {
  const member = await prisma.firmMember.findFirst({
    where: { id: memberId, firmId },
    select: MEMBER_SELECT,
  });
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Team member not found');
  }
  return member;
};

const ghlErrorMessage = (error: GhlApiError): string => {
  const body = error.body as { message?: unknown } | null | undefined;
  const detail = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
  return typeof detail === 'string' && detail ? detail : error.message;
};

/**
 * Adds the user to the firm's GoHighLevel sub-account as a plain `user`. Skipped
 * when the firm is not linked to a sub-account. Tries the firm's own token, and
 * falls back to the agency token when that one lacks the users.write scope.
 */
const createStaffInGhl = async (
  firmId: string,
  input: { firstName: string; lastName: string; email: string; phone?: string; password: string }
): Promise<void> => {
  const firm = await prisma.firm.findUnique({
    where: { id: firmId },
    select: { ghlLocationId: true, ghlCompanyId: true },
  });
  if (!firm?.ghlLocationId) return;

  const locationId = firm.ghlLocationId;
  const firmToken = await ghlTokenProvider.forFirm(firmId);

  const attempt = async (token: typeof firmToken) => {
    const companyId = firm.ghlCompanyId ?? (await fetchLocation(token, locationId)).companyId;
    if (!companyId) {
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Could not determine the GoHighLevel company for this sub-account'
      );
    }
    await createLocationUser(token, { ...input, companyId, locationId });
  };

  try {
    try {
      await attempt(firmToken);
    } catch (error) {
      if (!(error instanceof GhlApiError && error.isAuthError)) throw error;
      const agencyToken = await ghlTokenProvider.forAgencyConnection().catch(() => null);
      if (!agencyToken) throw error;
      await attempt(agencyToken);
    }
  } catch (error) {
    if (!(error instanceof GhlApiError)) throw error;
    if (error.status === 0) {
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Could not reach GoHighLevel to add this team member. Please try again.'
      );
    }
    throw new ApiError(
      error.isAuthError ? httpStatus.BAD_REQUEST : httpStatus.BAD_GATEWAY,
      error.isAuthError
        ? 'GoHighLevel refused to add this user. Give the sub-account token the users.write scope, then reconnect the sub-account.'
        : `GoHighLevel could not add this team member: ${ghlErrorMessage(error)}`
    );
  }
};

interface CreateTeamMemberInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  staffType: StaffType;
  title?: string;
}

export const createTeamMember = async (
  firmId: string,
  createdByUserId: string,
  input: CreateTeamMemberInput
) => {
  const email = input.email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'That email is already in use');
  }

  const temporaryPassword = generateRandomPassword();
  const passwordHash = await hashSecret(temporaryPassword);

  // A firm linked to a GoHighLevel sub-account keeps its staff there too. Done
  // first so a rejected GHL call never leaves a local member GHL doesn't know.
  await createStaffInGhl(firmId, { ...input, email, password: temporaryPassword });

  const member = await prisma.$transaction(async (tx) => {
    // user creation and the team role only depend on `firmId`/inputs already
    // known - run them concurrently instead of as 2 sequential round trips.
    const [user, teamRole] = await Promise.all([
      tx.user.create({
        data: {
          email,
          phone: input.phone,
          firstName: input.firstName,
          lastName: input.lastName,
          displayName: `${input.firstName} ${input.lastName}`,
          passwordHash,
          accountRole: 'FIRM_TEAM',
          status: 'ACTIVE',
        },
      }),
      tx.role.upsert({
        where: { firmId_key: { firmId, key: 'team' } },
        update: {},
        create: { firmId, key: 'team', name: 'Team', isSystem: true, permissions: [] },
      }),
    ]);

    const createdMember = await tx.firmMember.create({
      data: {
        firmId,
        userId: user.id,
        staffType: input.staffType,
        title: input.title,
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
      select: MEMBER_SELECT,
    });

    await tx.firmMemberRole.create({
      data: { memberId: createdMember.id, roleId: teamRole.id, grantedById: createdByUserId },
    });

    return createdMember;
  }, TX_OPTIONS);

  return { member, temporaryPassword };
};

interface ListTeamMembersQuery {
  page?: number;
  limit?: number;
  status?: MemberStatus;
}

export const listTeamMembers = async (firmId: string, query: ListTeamMembersQuery) => {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const where = { firmId, ...(query.status ? { status: query.status } : {}) };

  const [results, totalResults] = await Promise.all([
    prisma.firmMember.findMany({
      where,
      select: MEMBER_SELECT,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.firmMember.count({ where }),
  ]);

  return { results, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults };
};

export const getTeamMember = async (firmId: string, memberId: string) => {
  return assertFirmMember(firmId, memberId);
};

interface UpdateTeamMemberInput {
  firstName?: string;
  lastName?: string;
  phone?: string;
  staffType?: StaffType;
  title?: string;
}

export const updateTeamMember = async (
  firmId: string,
  memberId: string,
  input: UpdateTeamMemberInput
) => {
  const member = await assertFirmMember(firmId, memberId);

  await prisma.$transaction([
    prisma.firmMember.update({
      where: { id: member.id },
      data: { staffType: input.staffType, title: input.title },
    }),
    prisma.user.update({
      where: { id: member.user.id },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        displayName:
          input.firstName || input.lastName
            ? [input.firstName ?? member.user.firstName, input.lastName ?? member.user.lastName]
                .filter(Boolean)
                .join(' ')
            : undefined,
      },
    }),
  ]);

  return assertFirmMember(firmId, memberId);
};

export const setTeamMemberStatus = async (
  firmId: string,
  memberId: string,
  status: MemberStatus
) => {
  const member = await assertFirmMember(firmId, memberId);
  if (member.isOwner) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Can't change status of the firm owner");
  }

  await prisma.firmMember.update({
    where: { id: member.id },
    data: { status, deactivatedAt: status === 'DEACTIVATED' ? new Date() : null },
  });

  if (status === 'DEACTIVATED') {
    await revokeAllSessionsForUser(member.user.id);
  }

  return assertFirmMember(firmId, memberId);
};

export const resetTeamMemberPassword = async (firmId: string, memberId: string) => {
  const member = await assertFirmMember(firmId, memberId);

  const temporaryPassword = generateRandomPassword();
  const passwordHash = await hashSecret(temporaryPassword);

  await prisma.user.update({ where: { id: member.user.id }, data: { passwordHash } });
  await revokeAllSessionsForUser(member.user.id);

  return { member, temporaryPassword };
};

// ---------------------------------------------------------------------------
// GoHighLevel team sync
// ---------------------------------------------------------------------------

export interface GhlTeamSyncResult {
  /** Users GoHighLevel returned for the sub-account. */
  fetched: number;
  created: number;
  /** Existing members whose name or phone was refreshed from GoHighLevel. */
  updated: number;
  /** No email, or an email that belongs to an account outside this team. */
  skipped: number;
}

export const ghlUserName = (user: GhlUser): { firstName: string; lastName: string } => {
  const full = user.name?.trim() ?? '';
  const [first, ...rest] = full.split(/\s+/).filter(Boolean);
  return {
    firstName: user.firstName?.trim() || first || user.email?.split('@')[0] || 'Team',
    lastName: user.lastName?.trim() || rest.join(' ') || '-',
  };
};

interface GhlTeamMemberProfile {
  email: string;
  phone?: string;
  firstName: string;
  lastName: string;
  displayName: string;
}

/** Creates the user, firm membership and team role for a GoHighLevel staff member. */
const provisionGhlTeamMember = async (
  firmId: string,
  teamRoleId: string,
  grantedById: string | undefined,
  profile: GhlTeamMemberProfile
) => {
  // Nobody knows this password: a GoHighLevel member signs in through the
  // firm's GoHighLevel link, and the firm admin can still set a real one.
  const passwordHash = await hashSecret(generateRandomPassword());

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: profile.email,
        phone: profile.phone,
        firstName: profile.firstName,
        lastName: profile.lastName,
        displayName: profile.displayName,
        passwordHash,
        accountRole: 'FIRM_TEAM',
        status: 'ACTIVE',
      },
      select: { id: true, accountRole: true },
    });
    const member = await tx.firmMember.create({
      data: {
        firmId,
        userId: user.id,
        staffType: 'PREPARER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    await tx.firmMemberRole.create({
      data: { memberId: member.id, roleId: teamRoleId, grantedById },
    });
    return user;
  }, TX_OPTIONS);
};

/**
 * The local account for a GoHighLevel staff member who has just opened the
 * firm's team link. Creates it on first visit; afterwards finds it by email.
 *
 * Refuses anything that would let the link sign in as someone it should not:
 * a deactivated member, the firm's admin (they use the owner link), or an email
 * that already belongs to an account outside this firm.
 */
export const findOrCreateGhlTeamMember = async (
  firmId: string,
  ghlUser: GhlUser,
  grantedById?: string
): Promise<{ id: string; accountRole: 'FIRM_TEAM' }> => {
  const email = ghlUser.email?.trim().toLowerCase();
  if (!email) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'This GoHighLevel user has no email address, so they cannot be signed in.'
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      accountRole: true,
      status: true,
      memberships: { where: { firmId }, select: { status: true }, take: 1 },
    },
  });

  if (existing) {
    const membership = existing.memberships[0];
    if (!membership) {
      throw new ApiError(
        httpStatus.CONFLICT,
        'That email already belongs to an account outside this firm.'
      );
    }
    if (existing.accountRole !== 'FIRM_TEAM') {
      throw new ApiError(httpStatus.FORBIDDEN, 'Firm owners sign in with the firm owner link.');
    }
    if (existing.status !== 'ACTIVE' || membership.status !== 'ACTIVE') {
      throw new ApiError(httpStatus.FORBIDDEN, 'This team member has been deactivated.');
    }
    return { id: existing.id, accountRole: 'FIRM_TEAM' };
  }

  const { firstName, lastName } = ghlUserName(ghlUser);
  const teamRole = await prisma.role.upsert({
    where: { firmId_key: { firmId, key: 'team' } },
    update: {},
    create: { firmId, key: 'team', name: 'Team', isSystem: true, permissions: [] },
  });
  const user = await provisionGhlTeamMember(firmId, teamRole.id, grantedById, {
    email,
    phone: ghlUser.phone?.trim() || undefined,
    firstName,
    lastName,
    displayName: ghlUser.name?.trim() || `${firstName} ${lastName}`,
  });
  return { id: user.id, accountRole: 'FIRM_TEAM' };
};

/**
 * Mirror the staff of the firm's own GoHighLevel sub-account into the firm's
 * team. Read-only against GoHighLevel and idempotent: matched by email, so
 * re-running never duplicates anyone. Existing members only get their name and
 * phone refreshed.
 *
 * Imported members get a random password nobody knows (the firm admin sets a
 * real one with "reset password"); no email is sent.
 */
export const syncTeamFromGhl = async (
  firmId: string,
  createdByUserId: string
): Promise<GhlTeamSyncResult> => {
  const token = await ghlTokenProvider.forFirm(firmId);

  let users: GhlUser[];
  try {
    users = await listLocationUsers(token);
  } catch (error) {
    if (error instanceof GhlApiError && error.isAuthError) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'The GoHighLevel sub-account token cannot read users. Give it the users.readonly scope in GoHighLevel, then reconnect the sub-account.'
      );
    }
    if (error instanceof GhlApiError && error.status === 0) {
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Could not reach GoHighLevel to fetch users. Please try again.'
      );
    }
    throw error;
  }

  const teamRole = await prisma.role.upsert({
    where: { firmId_key: { firmId, key: 'team' } },
    update: {},
    create: { firmId, key: 'team', name: 'Team', isSystem: true, permissions: [] },
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const ghlUser of users) {
    const email = ghlUser.email?.trim().toLowerCase();
    if (!email) {
      skipped += 1;
      continue;
    }

    const { firstName, lastName } = ghlUserName(ghlUser);
    const phone = ghlUser.phone?.trim() || undefined;
    const displayName = ghlUser.name?.trim() || `${firstName} ${lastName}`;

    const existing = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        accountRole: true,
        phone: true,
        displayName: true,
        memberships: { where: { firmId }, select: { id: true }, take: 1 },
      },
    });

    if (existing) {
      // Only refresh people already on this team. An account that belongs to
      // another firm, or a firm admin, is never touched.
      if (existing.accountRole !== 'FIRM_TEAM' || existing.memberships.length === 0) {
        skipped += 1;
        continue;
      }
      const changed = existing.displayName !== displayName || (phone && existing.phone !== phone);
      if (changed) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { firstName, lastName, displayName, ...(phone ? { phone } : {}) },
        });
        updated += 1;
      }
      continue;
    }

    await provisionGhlTeamMember(firmId, teamRole.id, createdByUserId, {
      email,
      phone,
      firstName,
      lastName,
      displayName,
    });
    created += 1;
  }

  logger.info(
    `GHL team sync for firm ${firmId}: fetched=${users.length} created=${created} updated=${updated} skipped=${skipped}`
  );
  return { fetched: users.length, created, updated, skipped };
};
