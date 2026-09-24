import { FirmStatus } from '@prisma/client';
import httpStatus from 'http-status';

import prisma, { TX_OPTIONS } from '@/client';
import config from '@/config/config';
import logger from '@/config/logger';
import { sendFirmAdminWelcomeEmail } from '@/shared/services/email.service';
import { revokeAllSessionsForUser } from '@/shared/services/token.service';
import ApiError from '@/shared/utils/api-error';
import {
  blindIndex,
  encryptPII,
  generateRandomPassword,
  hashSecret,
  lastDigits,
  normalizeDigits,
} from '@/shared/utils/encryption';

interface OnboardFirmInput {
  firm: {
    legalName: string;
    displayName?: string;
    ein?: string;
    licenseNumber?: string;
    licenseType?: string;
    website?: string;
    domain?: string;
    email?: string;
    phone?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
  };
  owner: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    ssn?: string;
  };
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const uniqueSlug = async (base: string): Promise<string> => {
  const root = slugify(base) || 'firm';
  let candidate = root;
  let suffix = 1;
  while (await prisma.firm.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    suffix += 1;
    candidate = `${root}-${suffix}`;
  }
  return candidate;
};

const FIRM_SAFE_SELECT = {
  id: true,
  name: true,
  legalName: true,
  slug: true,
  einLast4: true,
  ownerSsnLast4: true,
  licenseNumber: true,
  licenseType: true,
  website: true,
  domain: true,
  email: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * GoHighLevel sub-account provisioning is intentionally NOT performed yet.
 *
 * Product decision: onboarding a firm here must NOT create anything in
 * GoHighLevel. The sub-account is created by the agency separately and then
 * linked to this firm through the "Connect GHL" flow (modules/ghl), which
 * proves the sub-account exists with the agency token and stores that
 * sub-account's own private-integration token, encrypted.
 *
 * This logs the data a real provisioner would need so the intent stays visible
 * in the logs while the real call is on hold. It logs NO sensitive identifiers
 * - never the EIN, SSN, or any credential.
 */
const logGhlProvisionIntent = (
  firm: { id: string; name: string; slug: string; city?: string | null; state?: string | null },
  ownerEmail: string
): void => {
  logger.info(
    `GHL provisioning skipped (mock - no sub-account created). Would provision firm id=${firm.id} ` +
      `slug=${firm.slug} name="${firm.name}" owner=${ownerEmail} ` +
      `location=${firm.city ?? '-'}, ${firm.state ?? '-'}`
  );
};

export const onboardFirm = async (input: OnboardFirmInput, platformOwnerId?: string) => {
  const einDigits = input.firm.ein ? normalizeDigits(input.firm.ein) : undefined;
  const ssnDigits = input.owner.ssn ? normalizeDigits(input.owner.ssn) : undefined;

  if (!einDigits && !ssnDigits) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Provide at least the firm EIN or the owner SSN to uniquely identify this firm'
    );
  }

  const identityHash = blindIndex(
    einDigits ? ['EIN', einDigits] : null,
    ssnDigits ? ['SSN', ssnDigits] : null
  );

  const existingFirm = await prisma.firm.findUnique({ where: { identityHash } });
  if (existingFirm) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'A firm with this EIN/SSN is already registered on the platform'
    );
  }

  const ownerEmail = input.owner.email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (existingUser) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'That email is already in use');
  }

  const slug = await uniqueSlug(input.firm.displayName ?? input.firm.legalName);
  const temporaryPassword = generateRandomPassword();
  const passwordHash = await hashSecret(temporaryPassword);

  const result = await prisma.$transaction(async (tx) => {
    const firm = await tx.firm.create({
      data: {
        name: input.firm.displayName ?? input.firm.legalName,
        legalName: input.firm.legalName,
        slug,
        einEncrypted: einDigits ? encryptPII(einDigits) : undefined,
        einLast4: einDigits ? lastDigits(einDigits) : undefined,
        ownerSsnEncrypted: ssnDigits ? encryptPII(ssnDigits) : undefined,
        ownerSsnLast4: ssnDigits ? lastDigits(ssnDigits) : undefined,
        licenseNumber: input.firm.licenseNumber,
        licenseType: input.firm.licenseType,
        website: input.firm.website,
        domain: input.firm.domain,
        email: input.firm.email,
        phone: input.firm.phone,
        addressLine1: input.firm.address?.line1,
        addressLine2: input.firm.address?.line2,
        city: input.firm.address?.city,
        state: input.firm.address?.state,
        postalCode: input.firm.address?.postalCode,
        country: input.firm.address?.country ?? 'US',
        identityHash,
        status: FirmStatus.ACTIVE,
        createdByPlatformAdminId: platformOwnerId,
        settings: { create: {} },
      },
    });

    // owner creation and the admin role only depend on `firm`, not on each
    // other - run them concurrently to shave a round trip off the transaction.
    const [owner, adminRole] = await Promise.all([
      tx.user.create({
        data: {
          email: ownerEmail,
          phone: input.owner.phone,
          firstName: input.owner.firstName,
          lastName: input.owner.lastName,
          displayName: `${input.owner.firstName} ${input.owner.lastName}`,
          passwordHash,
          accountRole: 'FIRM_ADMIN',
          status: 'ACTIVE',
        },
      }),
      tx.role.upsert({
        where: { firmId_key: { firmId: firm.id, key: 'admin' } },
        update: {},
        create: {
          firmId: firm.id,
          key: 'admin',
          name: 'Admin',
          isSystem: true,
          permissions: [],
        },
      }),
    ]);

    const member = await tx.firmMember.create({
      data: {
        firmId: firm.id,
        userId: owner.id,
        staffType: 'OWNER',
        isOwner: true,
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });

    await tx.firmMemberRole.create({
      data: { memberId: member.id, roleId: adminRole.id, grantedById: platformOwnerId },
    });

    return { firm, owner };
  }, TX_OPTIONS);

  // GoHighLevel sub-account provisioning is deliberately on hold - see
  // logGhlProvisionIntent() for the reasoning, and modules/ghl/ghl.service.ts
  // for the flow that replaces it.
  logGhlProvisionIntent(result.firm, ownerEmail);

  // Fire-and-forget: the firm/owner records are already committed, so a slow
  // or unreachable SMTP server must not stall this request.
  sendFirmAdminWelcomeEmail(ownerEmail, result.firm.name, `${config.clientPortalUrl}/login`).catch(
    (error) => {
      logger.error('Failed to send firm admin welcome email: %s', (error as Error).message);
    }
  );

  return {
    firm: await prisma.firm.findUniqueOrThrow({
      where: { id: result.firm.id },
      select: FIRM_SAFE_SELECT,
    }),
    admin: {
      id: result.owner.id,
      email: result.owner.email,
      firstName: result.owner.firstName,
      lastName: result.owner.lastName,
    },
    temporaryPassword,
  };
};

interface ListFirmsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: FirmStatus;
}

export const listFirms = async (query: ListFirmsQuery) => {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { legalName: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [results, totalResults] = await Promise.all([
    prisma.firm.findMany({
      where,
      select: FIRM_SAFE_SELECT,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.firm.count({ where }),
  ]);

  return { results, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults };
};

export const getFirm = async (firmId: string) => {
  const firm = await prisma.firm.findUnique({
    where: { id: firmId },
    select: {
      ...FIRM_SAFE_SELECT,
      _count: { select: { members: true, clients: true } },
    },
  });
  if (!firm) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Firm not found');
  }
  return firm;
};

export const updateFirmStatus = async (firmId: string, status: FirmStatus) => {
  const firm = await prisma.firm.findUnique({ where: { id: firmId } });
  if (!firm) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Firm not found');
  }

  await prisma.firm.update({ where: { id: firmId }, data: { status } });

  if (status === 'SUSPENDED' || status === 'CANCELLED') {
    const [members, clientAccess] = await Promise.all([
      prisma.firmMember.findMany({ where: { firmId }, select: { userId: true } }),
      prisma.clientAccess.findMany({
        where: { client: { firmId } },
        select: { userId: true },
      }),
    ]);
    const userIds = [
      ...new Set([...members.map((m) => m.userId), ...clientAccess.map((c) => c.userId)]),
    ];
    await Promise.all(userIds.map((userId) => revokeAllSessionsForUser(userId)));
  }

  return getFirm(firmId);
};
