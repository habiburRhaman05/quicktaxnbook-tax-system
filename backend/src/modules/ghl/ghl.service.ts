import { AccountRole, IntegrationProvider, IntegrationStatus } from '@prisma/client';
import httpStatus from 'http-status';

import prisma, { TX_OPTIONS } from '@/client';
import config from '@/config/config';
import logger from '@/config/logger';
import ApiError from '@/shared/utils/api-error';

import { GhlApiError, ghlRequest } from './ghl.client';
import { ghlTokenProvider } from './ghl.tokens';
import type {
  GhlContact,
  GhlLocation,
  GhlLocationPrecheck,
  GhlLocationResponse,
  GhlLocationSummary,
  GhlPrecheckReason,
  GhlToken,
  GhlUser,
} from './ghl.types';

const toSummary = (location: GhlLocation): GhlLocationSummary => ({
  locationId: location.id,
  name: location.name ?? location.business?.name ?? null,
  companyId: location.companyId ?? null,
  email: location.email ?? null,
  phone: location.phone ?? null,
});

/**
 * `GET /locations/:locationId`
 * Verified against https://marketplace.gohighlevel.com/docs/ghl/locations/get-location/
 * (header `Version: 2021-07-28`, response `{ location: { id, companyId, name, ... } }`).
 */
export const fetchLocation = async (token: GhlToken, locationId: string): Promise<GhlLocation> => {
  const { data } = await ghlRequest<GhlLocationResponse>({
    path: `/locations/${encodeURIComponent(locationId)}`,
    token,
    concurrencyKey: locationId,
  });

  if (!data?.location?.id) {
    throw new GhlApiError('GoHighLevel returned an unexpected location payload', 502);
  }
  return data.location;
};

/**
 * Step 1 of the Connect flow: is this sub-account real, and is it already
 * spoken for? Runs with the agency token and never blocks the user - if we
 * cannot answer (GHL off, no agency token, token rejected, GHL down) we report
 * `checked: false` with a reason and let the flow continue to the token step,
 * where the pasted sub-account token is verified live.
 */
export const precheckLocation = async (locationId: string): Promise<GhlLocationPrecheck> => {
  // "Already connected" is answered from our own database, so it stays correct
  // even when GHL is unreachable.
  const linkedFirm = await prisma.firm.findUnique({
    where: { ghlLocationId: locationId },
    select: { id: true },
  });
  const connectedFirmId = linkedFirm?.id ?? null;

  if (!config.ghl.enabled) {
    return { checked: false, exists: false, reason: 'GHL_DISABLED', connectedFirmId };
  }
  let agency: GhlToken;
  try {
    agency = await ghlTokenProvider.forAgencyConnection();
  } catch {
    // No agency credential at all. Not fatal: the connect flow continues to the
    // token step, where the pasted sub-account token is verified live.
    return { checked: false, exists: false, reason: 'AGENCY_TOKEN_MISSING', connectedFirmId };
  }

  try {
    const location = await fetchLocation(agency, locationId);
    return {
      checked: true,
      exists: true,
      location: toSummary(location),
      connectedFirmId,
    };
  } catch (error) {
    if (error instanceof GhlApiError) {
      if (error.status === 404) {
        return { checked: true, exists: false, reason: 'LOCATION_NOT_FOUND', connectedFirmId };
      }
      if (error.isAuthError) {
        // Either the agency token lacks the location scope, or agency tokens are
        // simply not accepted by this endpoint. Degrade to the PIT-only path
        // rather than dead-ending the user.
        logger.warn(
          `GHL agency precheck rejected (status ${error.status}); falling back to PIT-only connect`
        );
        return { checked: false, exists: false, reason: 'AGENCY_TOKEN_REJECTED', connectedFirmId };
      }
    }
    logger.warn(`GHL agency precheck failed: ${(error as Error).message}`);
    return { checked: false, exists: false, reason: 'GHL_UNREACHABLE', connectedFirmId };
  }
};

/**
 * Step 2: prove that a pasted sub-account token actually works, and that it
 * belongs to *this* sub-account - a valid token for a different location must
 * never be accepted as proof here. Returns the location as GHL describes it, so
 * the UI can show the firm owner what they just connected.
 */
export const verifyLocationToken = async (
  locationId: string,
  privateToken: string
): Promise<GhlLocationSummary> => {
  const token = ghlTokenProvider.forLocation(locationId, privateToken);

  let location: GhlLocation;
  try {
    location = await fetchLocation(token, locationId);
  } catch (error) {
    if (error instanceof GhlApiError && error.isAuthError) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        'That GoHighLevel token was rejected. Check that it was copied in full and belongs to this sub-account.'
      );
    }
    if (error instanceof GhlApiError && error.status === 404) {
      throw new ApiError(httpStatus.NOT_FOUND, 'GoHighLevel has no sub-account with that id.');
    }
    logger.warn(`GHL token verification failed: ${(error as Error).message}`);
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      'Could not verify that token with GoHighLevel. Please try again.'
    );
  }

  if (location.id !== locationId) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'That token belongs to a different GoHighLevel sub-account.'
    );
  }

  return toSummary(location);
};

/**
 * Steps 1–3: verify and then attach a sub-account to a firm, storing the token
 * encrypted. Never creates anything in GoHighLevel - the sub-account already
 * exists; we are only linking to it.
 */
export const connectFirmToLocation = async (params: {
  firmId: string;
  locationId: string;
  privateToken: string;
  actorId?: string;
  /** Pre-verified location, so callers that already checked need not pay for a
   * second round trip. Omit to verify here (the historical behaviour). */
  summary?: GhlLocationSummary;
}): Promise<GhlLocationSummary> => {
  const firm = await prisma.firm.findUnique({
    where: { id: params.firmId },
    select: { id: true, name: true, ghlLocationId: true },
  });
  if (!firm) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Firm not found');
  }

  const claimedBy = await prisma.firm.findUnique({
    where: { ghlLocationId: params.locationId },
    select: { id: true },
  });
  if (claimedBy && claimedBy.id !== firm.id) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'That GoHighLevel sub-account is already connected to another firm.'
    );
  }

  // Live check before we persist anything, so a bad token can never be stored.
  const summary =
    params.summary ?? (await verifyLocationToken(params.locationId, params.privateToken));

  await prisma.$transaction(async (tx) => {
    await ghlTokenProvider.saveFirmLocationToken(
      {
        firmId: params.firmId,
        locationId: params.locationId,
        companyId: summary.companyId,
        privateToken: params.privateToken,
      },
      tx
    );

    await tx.firm.update({
      where: { id: params.firmId },
      data: {
        ghlLocationId: params.locationId,
        ghlCompanyId: summary.companyId,
        ghlConnectedAt: new Date(),
      },
    });

    // Note what changed - never the credential itself.
    await tx.auditLog.create({
      data: {
        firmId: params.firmId,
        actorId: params.actorId,
        actorType: params.actorId ? 'USER' : 'SYSTEM',
        action: firm.ghlLocationId ? 'integration.ghl.rotated' : 'integration.ghl.connected',
        entityType: 'Firm',
        entityId: params.firmId,
        summary: `GoHighLevel sub-account "${summary.name ?? params.locationId}" connected`,
        before: { ghlLocationId: firm.ghlLocationId },
        after: {
          ghlLocationId: params.locationId,
          ghlCompanyId: summary.companyId,
        },
      },
    });
  }, TX_OPTIONS);

  logger.info(`Firm ${params.firmId} connected to GHL location ${params.locationId}`);

  return summary;
};

/** `GET /locations/search` response. */
interface GhlLocationSearchResponse {
  locations?: GhlLocation[];
}

export interface GhlAgencyLocationList {
  locations: GhlLocationSummary[];
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Every sub-account under an agency.
 *
 * `GET /locations/search` - verified against
 * https://marketplace.gohighlevel.com/docs/ghl/locations/search-locations/
 * (query `companyId`, `skip`, `limit`, `order`, `email` -> `{ locations: [...] }`).
 *
 * `companyId` is optional on the wire: GHL scopes the search to the token's own
 * agency when it is omitted, so we only send it when we already know it.
 */
export const listAgencyLocations = async (
  token: GhlToken,
  options: { companyId?: string; page?: number; limit?: number } = {}
): Promise<GhlAgencyLocationList> => {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const page = Math.max(options.page ?? 1, 1);
  const companyId = options.companyId ?? config.ghl.companyId;

  const { data } = await ghlRequest<GhlLocationSearchResponse>({
    path: '/locations/search',
    token,
    query: {
      ...(companyId ? { companyId } : {}),
      skip: (page - 1) * limit,
      limit,
    },
    concurrencyKey: companyId ?? 'agency',
  });

  const locations = (data?.locations ?? []).map(toSummary);
  return { locations, page, limit, hasMore: locations.length === limit };
};

export interface GhlAgencyVerification {
  companyId: string | null;
  companyName: string | null;
  /** One location, returned so the UI can show *which* agency just connected. */
  sampleLocation: GhlLocationSummary | null;
}

/**
 * Proves a pasted agency token works, and reads what we can about the agency.
 *
 * Uses only endpoints verified in docs/GHL_INTEGRATION_PLAN.md section 7:
 *  1. list this agency's sub-accounts;
 *  2. read the first one, because `GET /locations/:locationId` is the one
 *     verified response that carries `companyId`. There is no confirmed
 *     "who am I / my company" endpoint for a token, so we derive it instead of
 *     inventing one.
 *
 * If the agency has no sub-accounts yet, `companyId` cannot be derived this way
 * and is reported as null - the caller should then ask for it explicitly.
 */
export const verifyAgencyToken = async (privateToken: string): Promise<GhlAgencyVerification> => {
  const token = ghlTokenProvider.fromAgencyPrivateToken(privateToken);

  try {
    const page = await listAgencyLocations(token, { limit: 1 });
    const sample = page.locations[0] ?? null;

    if (!sample) {
      return {
        companyId: config.ghl.companyId ?? null,
        companyName: null,
        sampleLocation: null,
      };
    }

    const location = await fetchLocation(token, sample.locationId);
    return {
      companyId: location.companyId ?? config.ghl.companyId ?? null,
      companyName: location.business?.name ?? location.name ?? null,
      sampleLocation: sample,
    };
  } catch (error) {
    if (error instanceof GhlApiError && error.isAuthError) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        'That GoHighLevel agency token was rejected. Check it was copied in full and includes permission to read locations.'
      );
    }
    if (error instanceof GhlApiError && error.status === 0) {
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Could not reach GoHighLevel to validate that token. Please try again.'
      );
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Firm flow - the /firms/:locationId page, opened from a GoHighLevel custom menu
// ---------------------------------------------------------------------------
// The sub-account id arrives in the URL and is NEVER trusted on its own: it is
// checked against the connected agency first, and only then do we ask the firm
// owner for that sub-account's own Private Integration Token.

export interface GhlLinkedFirm {
  id: string;
  name: string;
  slug: string;
}

/** Everything the `/firms/:locationId` page needs to decide what to render. */
export interface GhlFirmLocationState {
  /** True once we could actually ask GoHighLevel (an agency token worked). */
  checked: boolean;
  exists: boolean;
  reason?: GhlPrecheckReason;
  location: GhlLocationSummary | null;
  /** The firm this sub-account is linked to, if any. */
  firm: GhlLinkedFirm | null;
  /** True when that firm already holds a working sub-account token. */
  connected: boolean;
}

export const findLinkedFirm = (locationId: string): Promise<GhlLinkedFirm | null> =>
  prisma.firm.findUnique({
    where: { ghlLocationId: locationId },
    select: { id: true, name: true, slug: true },
  });

export const hasWorkingCredential = async (firmId: string): Promise<boolean> => {
  const integration = await prisma.integration.findUnique({
    where: { firmId_provider: { firmId, provider: IntegrationProvider.GOHIGHLEVEL } },
    select: { status: true, configEncrypted: true },
  });
  return (
    integration?.status === IntegrationStatus.CONNECTED && Boolean(integration.configEncrypted)
  );
};

/**
 * Is this a real sub-account under our agency, is it linked to a firm, and does
 * that firm already hold a working token? Runs the same non-blocking agency
 * pre-check as the connect flow, so a GHL outage degrades to `checked: false`
 * rather than a dead end.
 */
export const getFirmLocationState = async (locationId: string): Promise<GhlFirmLocationState> => {
  const precheck = await precheckLocation(locationId);
  const firm = await findLinkedFirm(locationId);

  return {
    checked: precheck.checked,
    exists: precheck.exists,
    reason: precheck.reason,
    location: precheck.location ?? null,
    firm,
    connected: firm ? await hasWorkingCredential(firm.id) : false,
  };
};

/**
 * The firm's active owner, or failing that its first active member, so the
 * connect flow can sign someone in. Returns `null` when the firm has no usable
 * account - the caller decides what that means.
 */
export const resolveFirmOwner = async (
  firmId: string
): Promise<{ id: string; accountRole: AccountRole } | null> => {
  const member = await prisma.firmMember.findFirst({
    where: { firmId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
    orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
    select: { user: { select: { id: true, accountRole: true } } },
  });
  return member?.user ?? null;
};

export interface ConnectFirmResult {
  firm: GhlLinkedFirm;
  owner: { id: string; accountRole: AccountRole };
  location: GhlLocationSummary;
}

/**
 * The public connect step: prove the pasted sub-account PIT works, store it
 * against the firm already linked to this sub-account, and hand back that
 * firm's owner so the caller can start a session.
 *
 * The firm must already be linked (`Firm.ghlLocationId`). This flow never
 * invents a firm from a GoHighLevel payload - sub-accounts are linked to firms
 * deliberately, not on first sight of a URL.
 */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const uniqueFirmSlug = async (base: string): Promise<string> => {
  const root = slugify(base) || 'firm';
  let candidate = root;
  let suffix = 1;
  while (await prisma.firm.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    suffix += 1;
    candidate = `${root}-${suffix}`;
  }
  return candidate;
};

const findFirmByEmail = (email: string): Promise<GhlLinkedFirm | null> =>
  prisma.firm.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, name: true, slug: true },
  });

const findFirmByOwnerEmail = async (email: string): Promise<GhlLinkedFirm | null> => {
  const member = await prisma.firmMember.findFirst({
    where: {
      status: 'ACTIVE',
      user: { email: { equals: email, mode: 'insensitive' } },
    },
    orderBy: [{ isOwner: 'desc' }, { createdAt: 'asc' }],
    select: { firm: { select: { id: true, name: true, slug: true } } },
  });
  return member?.firm ?? null;
};

/**
 * Resolves the firm a verified sub-account belongs to, creating one when the
 * sub-account has never been seen before.
 *
 * Order matters: an already-linked firm wins, then a firm already on the
 * platform with the same contact email (so clicking the menu link can never
 * silently duplicate an onboarded firm), and only then a brand-new firm. The
 * created firm's owner is passwordless on purpose - the sub-account's PIT is how
 * they sign in, exactly like the agency flow.
 */
const ensureFirmForLocation = async (
  location: GhlLocationSummary,
  actorId?: string
): Promise<{ firm: GhlLinkedFirm; owner: { id: string; accountRole: AccountRole } }> => {
  const linked = await findLinkedFirm(location.locationId);
  if (linked) {
    const owner = await resolveFirmOwner(linked.id);
    if (!owner) {
      throw new ApiError(
        httpStatus.CONFLICT,
        'This firm has no active owner account to sign in with.'
      );
    }
    return { firm: linked, owner };
  }

  const email = location.email?.trim().toLowerCase() || null;

  if (email) {
    const matched = (await findFirmByEmail(email)) ?? (await findFirmByOwnerEmail(email));
    if (matched) {
      await linkLocationToFirm({
        firmId: matched.id,
        locationId: location.locationId,
        actorId,
        verifiedLocation: location,
      });
      const owner = await resolveFirmOwner(matched.id);
      if (!owner) {
        throw new ApiError(
          httpStatus.CONFLICT,
          'This firm has no active owner account to sign in with.'
        );
      }
      return { firm: matched, owner };
    }
  }

  const name = location.name?.trim() || `GoHighLevel ${location.companyId ?? 'firm'}`;
  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ') || null;

  return prisma.$transaction(async (tx) => {
    const firm = await tx.firm.create({
      data: {
        name,
        legalName: name,
        slug: await uniqueFirmSlug(name),
        email,
        phone: location.phone ?? null,
        country: 'US',
        status: 'ACTIVE',
        // Set now so a retry after a failed token store links to this same
        // firm instead of creating a second one.
        ghlLocationId: location.locationId,
        ghlCompanyId: location.companyId,
        ghlConnectedAt: new Date(),
        settings: { create: {} },
      },
      select: { id: true, name: true, slug: true },
    });

    // A GoHighLevel location's contact email is NOT proof that it owns an
    // existing account: it may be the platform owner's or an unrelated user's
    // address. Reusing it would hand that person a second firm and could fail
    // the unique-email constraint, so fall back to a passwordless owner - the
    // sub-account's PIT is how they sign in.
    const emailTaken = email
      ? await tx.user.findUnique({ where: { email }, select: { id: true } })
      : null;

    const owner = await tx.user.create({
      data: {
        email: emailTaken ? null : email,
        firstName: firstName || null,
        lastName,
        displayName: name,
        accountRole: 'FIRM_ADMIN',
        status: 'ACTIVE',
      },
      select: { id: true, accountRole: true },
    });

    const adminRole = await tx.role.upsert({
      where: { firmId_key: { firmId: firm.id, key: 'admin' } },
      update: {},
      create: {
        firmId: firm.id,
        key: 'admin',
        name: 'Admin',
        isSystem: true,
        permissions: [],
      },
    });

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
      data: { memberId: member.id, roleId: adminRole.id, grantedById: actorId },
    });

    logger.info(
      `GHL sub-account ${location.locationId} provisioned firm ${firm.id} (self-serve connect)`
    );

    return { firm, owner };
  }, TX_OPTIONS);
};

/**
 * The public connect step: prove the pasted sub-account PIT works, resolve (or
 * create) the firm this sub-account belongs to, store the token against it, and
 * hand back that firm's owner so the caller can start a session.
 *
 * The token is verified FIRST, so a bad token can never leave a firm behind.
 */
export const connectFirmByLocation = async (params: {
  locationId: string;
  privateToken: string;
  actorId?: string;
}): Promise<ConnectFirmResult> => {
  const summary = await verifyLocationToken(params.locationId, params.privateToken);

  const { firm, owner } = await ensureFirmForLocation(summary, params.actorId);

  const location = await connectFirmToLocation({
    firmId: firm.id,
    locationId: params.locationId,
    privateToken: params.privateToken,
    summary,
    actorId: params.actorId,
  });

  return { firm, owner, location };
};

/**
 * Links a GoHighLevel sub-account to an existing firm. Agency-session only: the
 * sub-account must be verifiable under the connected agency before anything is
 * written, and a sub-account already linked elsewhere is refused. Deliberately
 * does NOT store a credential - that is the `/firms/:locationId` step.
 */
export const linkLocationToFirm = async (params: {
  firmId: string;
  locationId: string;
  actorId?: string;
  /** Already-verified location, skipping the agency pre-check round trip. */
  verifiedLocation?: GhlLocationSummary;
}): Promise<{ firm: GhlLinkedFirm; location: GhlLocationSummary | null }> => {
  const firm = await prisma.firm.findUnique({
    where: { id: params.firmId },
    select: { id: true, name: true, slug: true, ghlLocationId: true },
  });
  if (!firm) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Firm not found');
  }

  let location = params.verifiedLocation ?? null;
  if (!location) {
    const precheck = await precheckLocation(params.locationId);
    if (!precheck.checked || !precheck.exists) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'That GoHighLevel sub-account was not found under the connected agency.'
      );
    }
    location = precheck.location ?? null;
  }

  const claimedBy = await prisma.firm.findUnique({
    where: { ghlLocationId: params.locationId },
    select: { id: true },
  });
  if (claimedBy && claimedBy.id !== firm.id) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'That GoHighLevel sub-account is already linked to another firm.'
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.firm.update({
      where: { id: firm.id },
      data: {
        ghlLocationId: params.locationId,
        ghlCompanyId: location?.companyId ?? undefined,
      },
    });

    await tx.auditLog.create({
      data: {
        firmId: firm.id,
        actorId: params.actorId,
        actorType: params.actorId ? 'USER' : 'SYSTEM',
        action: firm.ghlLocationId ? 'integration.ghl.relinked' : 'integration.ghl.linked',
        entityType: 'Firm',
        entityId: firm.id,
        summary: `GoHighLevel sub-account "${location?.name ?? params.locationId}" linked`,
        before: { ghlLocationId: firm.ghlLocationId },
        after: { ghlLocationId: params.locationId },
      },
    });
  }, TX_OPTIONS);

  logger.info(`Firm ${firm.id} linked to GHL location ${params.locationId}`);

  return {
    firm: { id: firm.id, name: firm.name, slug: firm.slug },
    location,
  };
};

// ---------------------------------------------------------------------------
// Contacts - used by the firm's "fetch clients from GoHighLevel" sync
// ---------------------------------------------------------------------------

interface GhlContactSearchResponse {
  contacts?: GhlContact[];
  total?: number;
}

const CONTACT_PAGE_LIMIT = 100;
/** Hard cap so one sync can never walk an unbounded contact list. */
const CONTACT_MAX_PAGES = 20;

export interface GhlContactList {
  contacts: GhlContact[];
  total: number;
  /** True when the page cap was hit - some contacts were not read. */
  truncated: boolean;
}

/**
 * Every contact under a sub-account carrying `tag`.
 *
 * `POST /contacts/search` - verified against the HighLevel API v2 reference
 * (`{ locationId, page, pageLimit, filters: [{ field, operator, value }] }`, and
 * the response carries a `total`). Uses the *sub-account's own* token, so it can
 * only ever read that sub-account's contacts.
 *
 * The tag is applied again here, in code: the upstream operator is a contains
 * match, and this guarantees we never treat an untagged contact as a client.
 */
export const listContactsByTag = async (
  token: GhlToken,
  tag: string,
  options: { locationId?: string; maxPages?: number } = {}
): Promise<GhlContactList> => {
  const locationId = options.locationId ?? token.locationId;
  const maxPages = options.maxPages ?? CONTACT_MAX_PAGES;
  // Tag names are compared ignoring case and hyphen/underscore/space differences,
  // so "new-client", "New Client" and "new_client" are the same tag.
  const normalizeTag = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const wanted = normalizeTag(tag);

  const collected: GhlContact[] = [];
  let total = 0;
  let pagesRead = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data } = await ghlRequest<GhlContactSearchResponse>({
      path: '/contacts/search',
      method: 'POST',
      token,
      body: {
        ...(locationId ? { locationId } : {}),
        page,
        pageLimit: CONTACT_PAGE_LIMIT,
        filters: [{ field: 'tags', operator: 'contains', value: tag }],
      },
      concurrencyKey: locationId,
    });

    pagesRead = page;
    const batch = data?.contacts ?? [];
    if (typeof data?.total === 'number') total = data.total;
    collected.push(...batch);

    if (batch.length < CONTACT_PAGE_LIMIT) break;
  }

  const contacts = collected.filter((contact) =>
    (contact.tags ?? []).some(
      (value) => typeof value === 'string' && normalizeTag(value) === wanted
    )
  );

  return {
    contacts,
    total,
    truncated: pagesRead === maxPages && collected.length >= maxPages * CONTACT_PAGE_LIMIT,
  };
};

/**
 * Every user (staff member) of a sub-account.
 *
 * `GET /users/?locationId=` - uses the sub-account's own token, so it needs the
 * `users.readonly` scope; an auth failure surfaces as a `GhlApiError` the caller
 * can turn into a clear message.
 */
export const listLocationUsers = async (
  token: GhlToken,
  options: { locationId?: string } = {}
): Promise<GhlUser[]> => {
  const locationId = options.locationId ?? token.locationId;
  const { data } = await ghlRequest<{ users?: GhlUser[] }>({
    path: '/users/',
    token,
    query: { locationId },
    concurrencyKey: locationId,
  });
  return data?.users ?? [];
};

export interface CreateLocationUserInput {
  companyId: string;
  locationId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  password: string;
}

/**
 * Create a staff user inside a sub-account (Settings -> My Staff).
 *
 * `POST /users/`. The role is pinned to `user` here on purpose: nothing this app
 * creates may ever be a GoHighLevel admin, and no caller can override it.
 */
export const createLocationUser = async (
  token: GhlToken,
  input: CreateLocationUserInput
): Promise<GhlUser> => {
  const { data } = await ghlRequest<GhlUser>({
    path: '/users/',
    method: 'POST',
    token,
    concurrencyKey: input.locationId,
    body: {
      companyId: input.companyId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      password: input.password,
      ...(input.phone ? { phone: input.phone } : {}),
      type: 'account',
      role: 'user',
      locationIds: [input.locationId],
    },
  });
  return data;
};

// ---------------------------------------------------------------------------
// Contact write-back - keeps the GoHighLevel contact in step with the client
// ---------------------------------------------------------------------------

/** Standard GoHighLevel contact fields we write. Never SSN/EIN or passwords. */
export interface GhlContactFields {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  website?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

const definedOnly = (fields: GhlContactFields): GhlContactFields =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value === 'string' && value.trim())
  ) as GhlContactFields;

/** `PUT /contacts/:contactId`. Only the given fields are changed. */
export const updateContact = async (
  token: GhlToken,
  contactId: string,
  fields: GhlContactFields
): Promise<void> => {
  await ghlRequest({
    path: `/contacts/${encodeURIComponent(contactId)}`,
    method: 'PUT',
    token,
    body: definedOnly(fields),
    concurrencyKey: token.locationId,
  });
};

/**
 * `POST /contacts/upsert`: creates the contact, or updates the one GoHighLevel
 * matches by email/phone. Returns its id so it can be stored on the client.
 */
export const upsertContact = async (
  token: GhlToken,
  locationId: string,
  fields: GhlContactFields
): Promise<string | null> => {
  const { data } = await ghlRequest<{ contact?: { id?: string } }>({
    path: '/contacts/upsert',
    method: 'POST',
    token,
    body: { locationId, ...definedOnly(fields) },
    concurrencyKey: locationId,
  });
  return data?.contact?.id ?? null;
};
