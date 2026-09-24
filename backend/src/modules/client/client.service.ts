import { ClientStatus, ClientType } from '@prisma/client';
import { add } from 'date-fns';
import httpStatus from 'http-status';

import prisma, { TX_OPTIONS } from '@/client';
import config from '@/config/config';
import logger from '@/config/logger';
import { GhlApiError } from '@/modules/ghl/ghl.client';
import { listContactsByTag, updateContact, upsertContact } from '@/modules/ghl/ghl.service';
import type { GhlContactFields, GhlContactList } from '@/modules/ghl/ghl.service';
import { ghlTokenProvider } from '@/modules/ghl/ghl.tokens';
import type { GhlContact } from '@/modules/ghl/ghl.types';
import {
  ghlContactIdOf,
  loadClientWebhookContext,
  postCrmWebhook,
} from '@/shared/services/crm-webhook.service';
import { createSession } from '@/shared/services/token.service';
import ApiError from '@/shared/utils/api-error';
import {
  encryptPII,
  generateSecureToken,
  hashSecret,
  hashToken,
  lastDigits,
  normalizeDigits,
} from '@/shared/utils/encryption';

interface CreateClientInput {
  displayName: string;
  type: ClientType;
  email?: string;
  phone?: string;
}

export const createClient = async (firmId: string, input: CreateClientInput) => {
  return prisma.client.create({
    data: {
      firmId,
      displayName: input.displayName,
      type: input.type,
      email: input.email?.toLowerCase(),
      phone: input.phone,
      status: 'ONBOARDING',
    },
  });
};

interface ListClientsQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export const listClients = async (firmId: string, query: ListClientsQuery) => {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const where = {
    firmId,
    deletedAt: null,
    ...(query.search
      ? { displayName: { contains: query.search, mode: 'insensitive' as const } }
      : {}),
  };

  const [results, totalResults] = await Promise.all([
    prisma.client.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.client.count({ where }),
  ]);

  return { results, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults };
};

const assertClient = async (firmId: string, clientId: string) => {
  const client = await prisma.client.findFirst({
    where: { id: clientId, firmId, deletedAt: null },
  });
  if (!client) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Client not found');
  }
  return client;
};

export const getClient = async (firmId: string, clientId: string) => {
  return assertClient(firmId, clientId);
};

export const updateClientStatus = async (
  firmId: string,
  clientId: string,
  status: Extract<ClientStatus, 'ACTIVE' | 'INACTIVE'>
) => {
  const client = await assertClient(firmId, clientId);
  if (client.status !== 'ACTIVE' && client.status !== 'INACTIVE') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Can't change status while the client is ${client.status.toLowerCase()}`
    );
  }
  return prisma.client.update({ where: { id: clientId }, data: { status } });
};

export const createOnboardingLink = async (
  firmId: string,
  clientId: string,
  createdById: string
) => {
  const client = await assertClient(firmId, clientId);
  const rawToken = generateSecureToken(32);
  const expiresAt = add(new Date(), { days: 7 });

  await prisma.onboardingLink.create({
    data: {
      firmId,
      clientId: client.id,
      type: 'NEW_CLIENT',
      tokenHash: hashToken(rawToken),
      sentTo: client.email,
      sentVia: client.email ? 'EMAIL' : undefined,
      createdById,
      expiresAt,
    },
  });

  const onboardingUrl = `${config.clientPortalUrl}/onboard/${rawToken}`;

  // The invite email is sent by the GoHighLevel workflow behind this webhook.
  // Fire-and-forget: the link is already saved and shown to the firm.
  void loadClientWebhookContext(client.id)
    .then((context) =>
      postCrmWebhook('client.onboarding_invite', {
        ...context,
        onboardingUrl,
        expiresAt: expiresAt.toISOString(),
      })
    )
    .catch((error) =>
      logger.error('Onboarding invite webhook failed: %s', (error as Error).message)
    );

  return { onboardingUrl, expiresAt };
};

export const getOnboardingLinkInfo = async (token: string) => {
  const tokenHash = hashToken(token);
  const link = await prisma.onboardingLink.findUnique({
    where: { tokenHash },
    include: {
      firm: { select: { name: true } },
      client: {
        select: {
          displayName: true,
          status: true,
          type: true,
          email: true,
          phone: true,
          metadata: true,
        },
      },
    },
  });

  if (!link || link.revokedAt || link.completedAt || link.expiresAt < new Date()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This onboarding link is invalid or has expired');
  }

  if (!link.openedAt) {
    await prisma.onboardingLink.update({ where: { id: link.id }, data: { openedAt: new Date() } });
  }

  // Best-effort split of the name the admin typed at creation, so the client
  // sees it pre-filled on the onboarding form instead of starting from blank
  // fields that don't match what the firm already has on file.
  const [splitFirst, ...rest] = link.client.displayName.trim().split(/\s+/);
  const meta = (link.client.metadata as Record<string, unknown> | null) ?? {};
  const fromGhl = (key: string) =>
    typeof meta[key] === 'string' && meta[key] ? (meta[key] as string) : undefined;
  // A GoHighLevel client keeps the contact's own first/last/company name, which
  // is more reliable than splitting the display name.
  const prefillFirstName = fromGhl('ghlFirstName') ?? (splitFirst || undefined);
  const prefillLastName = fromGhl('ghlLastName') ?? (rest.join(' ') || undefined);
  const prefillBusinessName = fromGhl('ghlCompanyName');

  return {
    firmName: link.firm.name,
    clientDisplayName: link.client.displayName,
    clientType: link.client.type,
    prefillFirstName: prefillFirstName || undefined,
    prefillLastName,
    prefillBusinessName,
    prefillEmail: link.client.email,
    prefillPhone: link.client.phone,
    expiresAt: link.expiresAt,
  };
};

interface OnboardingAddressInput {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface CompleteOnboardingInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  business?: {
    legalName: string;
    ein?: string;
    website?: string;
    phone?: string;
    address?: OnboardingAddressInput;
  };
}

/**
 * Writes client details to the firm's GoHighLevel contact: updates the linked
 * contact, or creates one (and remembers its id) for a client added by hand.
 * Skipped when the firm has no GoHighLevel connection. Never throws.
 */
export const pushClientToGhl = async (
  clientId: string,
  fields: GhlContactFields
): Promise<void> => {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { firmId: true, metadata: true, firm: { select: { ghlLocationId: true } } },
  });
  if (!client?.firm.ghlLocationId) return;

  let token;
  try {
    token = await ghlTokenProvider.forFirm(client.firmId);
  } catch {
    return;
  }

  try {
    const contactId = ghlContactIdOf(client.metadata);
    if (contactId) {
      await updateContact(token, contactId, fields);
    } else {
      const createdId = await upsertContact(token, client.firm.ghlLocationId, fields);
      if (createdId) {
        const metadata = (client.metadata as Record<string, unknown> | null) ?? {};
        await prisma.client.update({
          where: { id: clientId },
          data: { metadata: { ...metadata, ghlContactId: createdId } },
        });
      }
    }
    logger.info(`Client ${clientId} pushed to GoHighLevel contact`);
  } catch (error) {
    logger.warn(
      `Could not update GoHighLevel contact for client ${clientId}: ${(error as Error).message}`
    );
  }
};

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export const completeOnboarding = async (
  token: string,
  input: CompleteOnboardingInput,
  meta: RequestMeta
) => {
  const tokenHash = hashToken(token);
  const link = await prisma.onboardingLink.findUnique({
    where: { tokenHash },
    include: { client: { select: { id: true, firmId: true, type: true } } },
  });

  if (!link || link.revokedAt || link.completedAt || link.expiresAt < new Date()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This onboarding link is invalid or has expired');
  }

  const isBusiness = link.client.type !== 'INDIVIDUAL';
  if (isBusiness && !input.business?.legalName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Business legal name is required');
  }

  const email = input.email.toLowerCase();
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'That email is already in use');
  }

  const passwordHash = await hashSecret(input.password);
  const einDigits = input.business?.ein ? normalizeDigits(input.business.ein) : undefined;

  const businessAddress = isBusiness ? input.business?.address : undefined;
  const hasAddress = !!businessAddress && Object.values(businessAddress).some(Boolean);

  const { user } = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({
      data: {
        email,
        phone: input.phone,
        firstName: input.firstName,
        lastName: input.lastName,
        displayName: `${input.firstName} ${input.lastName}`,
        passwordHash,
        accountRole: 'FIRM_CLIENT',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    // None of these depend on each other's result - only on createdUser.id
    // (clientAccess) or values already known before the transaction started
    // - so run them concurrently instead of as 4 sequential round trips.
    await Promise.all([
      tx.clientAccess.create({
        data: {
          clientId: link.clientId,
          userId: createdUser.id,
          accessLevel: 'OWNER',
          isPrimary: true,
          invitedAt: link.createdAt,
          acceptedAt: new Date(),
        },
      }),
      tx.client.update({
        where: { id: link.clientId },
        data: {
          status: 'ACTIVE',
          onboardedAt: new Date(),
          ...(isBusiness
            ? {
                legalName: input.business?.legalName,
                website: input.business?.website,
                phone: input.business?.phone,
                email: undefined, // business email stays whatever the admin set at creation
                einEncrypted: einDigits ? encryptPII(einDigits) : undefined,
                einLast4: einDigits ? lastDigits(einDigits) : undefined,
              }
            : { email, phone: input.phone }),
        },
      }),
      hasAddress
        ? tx.address.create({
            data: {
              clientId: link.clientId,
              type: 'BUSINESS',
              line1: businessAddress?.line1 || '',
              line2: businessAddress?.line2,
              city: businessAddress?.city || '',
              state: businessAddress?.state,
              postalCode: businessAddress?.postalCode,
              country: businessAddress?.country || 'US',
              isPrimary: true,
            },
          })
        : Promise.resolve(),
      tx.onboardingLink.update({
        where: { id: link.id },
        data: { completedAt: new Date() },
      }),
    ]);

    return { user: createdUser };
  }, TX_OPTIONS);

  const tokens = await createSession(user, {
    firmId: link.client.firmId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  // Mirror what the client entered into their GoHighLevel contact, then fire
  // the welcome-email webhook. In the background: the client is already in.
  const ghlFields: GhlContactFields = {
    firstName: input.firstName,
    lastName: input.lastName,
    name: `${input.firstName} ${input.lastName}`,
    email,
    phone: input.phone,
    ...(isBusiness
      ? {
          companyName: input.business?.legalName,
          website: input.business?.website,
          address1: businessAddress?.line1,
          city: businessAddress?.city,
          state: businessAddress?.state,
          postalCode: businessAddress?.postalCode,
          country: businessAddress?.country,
        }
      : {}),
  };
  void (async () => {
    await pushClientToGhl(link.clientId, ghlFields);
    const context = await loadClientWebhookContext(link.clientId);
    await postCrmWebhook('client.onboarded', {
      ...context,
      contact: ghlFields,
      portalLoginUrl: `${config.clientPortalUrl}/client-login`,
    });
  })().catch((error) =>
    logger.error('Post-onboarding GoHighLevel sync failed: %s', (error as Error).message)
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      accountRole: user.accountRole,
    },
    tokens,
  };
};

// ---------------------------------------------------------------------------
// GoHighLevel client sync
// ---------------------------------------------------------------------------
// A firm's clients are the contacts in its own sub-account that carry the
// "client" tag - nothing else. This only READS from GoHighLevel and mirrors
// those contacts into `Client`, so the firm can work with them in the app.

const GHL_CLIENT_TAG = 'new-client';

const contactDisplayName = (contact: GhlContact): string => {
  const fullName = [contact.firstName, contact.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();
  return (
    fullName ||
    contact.contactName?.trim() ||
    contact.companyName?.trim() ||
    contact.email?.trim() ||
    contact.phone?.trim() ||
    'Unnamed client'
  );
};

/** What we remember about the GoHighLevel contact, so onboarding can prefill from it. */
const ghlMetadata = (contact: GhlContact) => ({
  ghlContactId: contact.id,
  ghlTags: contact.tags ?? [],
  ghlFirstName: contact.firstName?.trim() || null,
  ghlLastName: contact.lastName?.trim() || null,
  ghlCompanyName: contact.companyName?.trim() || null,
});

interface ExistingClientRef {
  id: string;
  email: string | null;
  phone: string | null;
  status?: string;
  source?: string | null;
  onboardedAt?: Date | null;
  metadata?: unknown;
}

export interface GhlClientSyncResult {
  tag: string;
  /** Contacts GHL returned for the tag. */
  fetched: number;
  created: number;
  updated: number;
  /** GHL's own count for the tag, when it reports one. */
  total: number;
  /** True when the page cap was hit, so some contacts were not read. */
  truncated: boolean;
}

/**
 * Pull every contact tagged `tag` out of the firm's sub-account and mirror it
 * into the firm's clients.
 *
 * Matching is by email, then phone, so re-running is idempotent and never
 * duplicates a client. Existing rows are only ever filled in, never
 * overwritten - a firm's own edits win over whatever GoHighLevel holds.
 *
 * The credential is the firm's own sub-account token, so this can only read
 * that sub-account; a firm with no working credential gets a clear 409 from
 * `ghlTokenProvider.forFirm`.
 */
export const syncClientsFromGhl = async (
  firmId: string,
  tag: string = GHL_CLIENT_TAG
): Promise<GhlClientSyncResult> => {
  const token = await ghlTokenProvider.forFirm(firmId);

  let listed: GhlContactList;
  try {
    listed = await listContactsByTag(token, tag);
  } catch (error) {
    if (error instanceof GhlApiError && error.isAuthError) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'The GoHighLevel sub-account token cannot read contacts. Give it the contacts scope in GoHighLevel, then reconnect the sub-account.'
      );
    }
    if (error instanceof GhlApiError && error.status === 0) {
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Could not reach GoHighLevel to fetch contacts. Please try again.'
      );
    }
    throw error;
  }

  const { contacts, total, truncated } = listed;

  const existing = await prisma.client.findMany({
    where: { firmId, deletedAt: null },
    select: {
      id: true,
      email: true,
      phone: true,
      status: true,
      source: true,
      onboardedAt: true,
      metadata: true,
    },
  });
  const byEmail = new Map<string, ExistingClientRef>();
  const byPhone = new Map<string, ExistingClientRef>();
  for (const client of existing) {
    if (client.email) byEmail.set(client.email.toLowerCase(), client);
    if (client.phone) byPhone.set(client.phone, client);
  }

  let created = 0;
  let updated = 0;

  for (const contact of contacts) {
    const email = contact.email?.trim().toLowerCase() || null;
    const phone = contact.phone?.trim() || null;
    const match =
      (email ? byEmail.get(email) : undefined) ?? (phone ? byPhone.get(phone) : undefined) ?? null;

    if (match) {
      // A GoHighLevel client is only active once they finish onboarding here;
      // undo any that were marked active without it.
      if (match.status === 'ACTIVE' && match.source === 'ghl' && !match.onboardedAt) {
        await prisma.client.update({ where: { id: match.id }, data: { status: 'ONBOARDING' } });
        updated += 1;
      }
      // Keep the remembered GoHighLevel names/tags current (used to prefill onboarding).
      if (match.source === 'ghl') {
        const before = JSON.stringify(match.metadata ?? {});
        const merged = { ...((match.metadata as Record<string, unknown> | null) ?? {}), ...ghlMetadata(contact) };
        if (JSON.stringify(merged) !== before) {
          await prisma.client.update({ where: { id: match.id }, data: { metadata: merged } });
          updated += 1;
        }
      }
      // Fill gaps only - never clobber what the firm edited by hand.
      const patch: { email?: string; phone?: string } = {};
      if (!match.email && email) patch.email = email;
      if (!match.phone && phone) patch.phone = phone;
      if (Object.keys(patch).length > 0) {
        await prisma.client.update({ where: { id: match.id }, data: patch });
        updated += 1;
      }
      continue;
    }

    const client = await prisma.client.create({
      data: {
        firmId,
        displayName: contactDisplayName(contact),
        type: contact.companyName?.trim() ? 'BUSINESS' : 'INDIVIDUAL',
        email,
        phone,
        // Same entry state as a manually added client: they get portal access
        // once they complete the onboarding form.
        status: 'ONBOARDING',
        source: 'ghl',
        metadata: ghlMetadata(contact),
      },
      select: { id: true, email: true, phone: true },
    });

    if (client.email) byEmail.set(client.email.toLowerCase(), client);
    if (client.phone) byPhone.set(client.phone, client);
    created += 1;
  }

  logger.info(
    `GHL client sync for firm ${firmId}: fetched=${contacts.length} created=${created} updated=${updated} truncated=${truncated}`
  );

  return { tag, fetched: contacts.length, created, updated, total, truncated };
};
