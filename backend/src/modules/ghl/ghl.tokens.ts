import { IntegrationProvider, IntegrationStatus, Prisma } from '@prisma/client';
import httpStatus from 'http-status';

import prisma from '@/client';
import config from '@/config/config';
import ApiError from '@/shared/utils/api-error';
import { decryptPII, encryptPII } from '@/shared/utils/encryption';

import type { GhlToken } from './ghl.types';

/**
 * The only place that knows where a GoHighLevel credential comes from.
 *
 * Callers ask for a token *kind* and get a ready-to-use one. They never read
 * env vars, never query the `Integration` table and never see a raw token from
 * anywhere else - so moving from "agency token + locationId" to "one token per
 * firm" is a change confined to this file.
 *
 * Tokens are never logged. Nothing here returns a token to an HTTP response.
 */

/** Agency (company) private-integration token, from env. */
const agencyToken = (): GhlToken => {
  const accessToken = config.ghl.agencyPrivateToken?.trim();
  if (!accessToken) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'GoHighLevel agency token is not configured (GHL_AGENCY_PIT)'
    );
  }
  return { kind: 'agency', accessToken };
};

/**
 * The agency credential to actually use for a call.
 *
 * Prefers the connection stored through the `/platform` flow (validated, entered
 * by the platform owner, encrypted at rest) and falls back to the
 * `GHL_AGENCY_PIT` env var so an operator can still pre-check sub-accounts before
 * the agency has been connected in the UI. Throws when neither exists, which
 * callers treat as "no agency credential" rather than an error.
 */
const forAgencyConnection = async (): Promise<GhlToken> => {
  const connection = await prisma.ghlAgencyConnection.findFirst({
    where: { status: IntegrationStatus.CONNECTED },
    orderBy: { createdAt: 'desc' },
    select: { tokenEncrypted: true },
  });

  if (connection?.tokenEncrypted) {
    try {
      return { kind: 'agency', accessToken: decryptPII(connection.tokenEncrypted) };
    } catch {
      throw new ApiError(
        httpStatus.CONFLICT,
        'The stored GoHighLevel agency credential could not be read. Reconnect the agency.'
      );
    }
  }

  return agencyToken();
};

/**
 * A firm's own sub-account token, decrypted from `Integration.configEncrypted`.
 * This is the credential every firm-scoped GHL call must use.
 */
const forFirm = async (firmId: string): Promise<GhlToken> => {
  const firm = await prisma.firm.findUnique({
    where: { id: firmId },
    select: { id: true, ghlLocationId: true },
  });
  if (!firm) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Firm not found');
  }
  if (!firm.ghlLocationId) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'This firm is not connected to a GoHighLevel sub-account yet'
    );
  }

  const integration = await prisma.integration.findUnique({
    where: { firmId_provider: { firmId, provider: IntegrationProvider.GOHIGHLEVEL } },
    select: { status: true, configEncrypted: true },
  });

  if (!integration?.configEncrypted || integration.status !== IntegrationStatus.CONNECTED) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'This firm has no working GoHighLevel credential on file'
    );
  }

  let accessToken: string;
  try {
    accessToken = decryptPII(integration.configEncrypted);
  } catch {
    // Thrown when the ciphertext no longer matches ENCRYPTION_KEY (usually a
    // key rotation). Surface it as a reconnect prompt, not a 500.
    throw new ApiError(
      httpStatus.CONFLICT,
      'The stored GoHighLevel credential could not be read. Reconnect this firm.'
    );
  }

  return { kind: 'location', accessToken, locationId: firm.ghlLocationId };
};

/**
 * A transient credential built from a token the user just pasted, used to prove
 * it works *before* anything is stored. Never persists anything by itself.
 */
const fromPrivateToken = (locationId: string, privateToken: string): GhlToken => {
  const accessToken = privateToken.trim();
  if (!accessToken) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'A GoHighLevel sub-account token is required'
    );
  }
  return { kind: 'location', accessToken, locationId };
};

/**
 * Encrypts and stores a verified sub-account token. Only ever called after the
 * token has been proven to work against the live API. Accepts a transaction
 * client so the caller can commit the credential and the firm linkage
 * atomically.
 */
const saveFirmLocationToken = async (
  params: {
    firmId: string;
    locationId: string;
    companyId?: string | null;
    privateToken: string;
  },
  tx: Prisma.TransactionClient = prisma
): Promise<void> => {
  const now = new Date();

  await tx.integration.upsert({
    where: {
      firmId_provider: { firmId: params.firmId, provider: IntegrationProvider.GOHIGHLEVEL },
    },
    create: {
      firmId: params.firmId,
      provider: IntegrationProvider.GOHIGHLEVEL,
      status: IntegrationStatus.CONNECTED,
      externalAccountId: params.locationId,
      configEncrypted: encryptPII(params.privateToken.trim()),
      lastVerifiedAt: now,
      lastSyncAt: now,
    },
    update: {
      status: IntegrationStatus.CONNECTED,
      externalAccountId: params.locationId,
      configEncrypted: encryptPII(params.privateToken.trim()),
      lastVerifiedAt: now,
      lastSyncAt: now,
      lastError: null,
    },
  });
};

/**
 * Transient agency credential built from a token the platform owner just pasted,
 * used to validate it *before* anything is stored. The counterpart of
 * `fromPrivateToken` for the agency scope.
 */
const fromAgencyPrivateToken = (privateToken: string): GhlToken => {
  const accessToken = privateToken.trim();
  if (!accessToken) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A GoHighLevel agency token is required');
  }
  return { kind: 'agency', accessToken };
};

export const ghlTokenProvider = {
  agency: agencyToken,
  forAgencyConnection,
  forFirm,
  forLocation: fromPrivateToken,
  fromAgencyPrivateToken,
  saveFirmLocationToken,
};
