import { IntegrationStatus, Prisma } from '@prisma/client';
import httpStatus from 'http-status';

import prisma from '@/client';
import config from '@/config/config';
import logger from '@/config/logger';
import ApiError from '@/shared/utils/api-error';
import { decryptPII, encryptPII } from '@/shared/utils/encryption';

import { GhlApiError } from './ghl.client';
import { listAgencyLocations, verifyAgencyToken } from './ghl.service';
import type { GhlAgencyLocationList } from './ghl.service';
import { ghlTokenProvider } from './ghl.tokens';

/**
 * The agency-scope GoHighLevel connection (backing the `/platform` flow).
 *
 * This deployment operates one agency, so the connection is treated as a
 * singleton: `getAgencyConnection()` returns the live one and `connectAgency()`
 * validates a pasted token and replaces it. `GhlAgencyConnection.companyId` is
 * unique, so a second agency can be added later without a schema change.
 *
 * The token itself never leaves this module - only `SAFE_SELECT` fields are ever
 * returned, and `tokenEncrypted` is never selected into a response.
 */

const SAFE_SELECT = {
  id: true,
  companyId: true,
  companyName: true,
  relationshipNumber: true,
  status: true,
  lastVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The connection as exposed to callers - never includes `tokenEncrypted`. */
export interface GhlAgencyConnectionSafe {
  id: string;
  companyId: string | null;
  companyName: string | null;
  relationshipNumber: string | null;
  status: IntegrationStatus;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const findLiveConnection = (): Promise<GhlAgencyConnectionSafe | null> =>
  prisma.ghlAgencyConnection.findFirst({
    where: { status: IntegrationStatus.CONNECTED },
    orderBy: { createdAt: 'desc' },
    select: SAFE_SELECT,
  });

/**
 * Current connection state - `null` means the `/platform` popup should be shown.
 *
 * A stored token GoHighLevel now rejects (revoked or rotated) counts as NOT
 * connected: it is marked as errored so the popup asks for a fresh one. Only an
 * explicit rejection does this; a GoHighLevel outage leaves the connection as is.
 */
export const getAgencyConnection = async () => {
  const connection = await findLiveConnection();
  if (!connection) return null;

  try {
    const token = await ghlTokenProvider.forAgencyConnection();
    await listAgencyLocations(token, { limit: 1, companyId: connection.companyId ?? undefined });
  } catch (error) {
    if (error instanceof GhlApiError && error.isAuthError) {
      await prisma.ghlAgencyConnection.update({
        where: { id: connection.id },
        data: { status: IntegrationStatus.ERROR, lastError: 'Token rejected by GoHighLevel' },
      });
      logger.warn('GHL agency token was rejected; connection marked as errored');
      return null;
    }
  }
  return connection;
};

/**
 * Connection state for the `/platform` popup. When the saved token has been
 * rejected, `previous` still carries the agency we knew (relationship number and name), so
 * the popup only asks for a fresh token instead of everything again.
 */
export const getAgencyState = async () => {
  const connection = await getAgencyConnection();
  if (connection) return { connection, previous: null };

  const last = await prisma.ghlAgencyConnection.findFirst({
    orderBy: { updatedAt: 'desc' },
    select: { companyId: true, companyName: true, relationshipNumber: true },
  });
  return { connection: null, previous: last };
};

export interface ConnectAgencyResult {
  connection: GhlAgencyConnectionSafe;
  /** What GHL told us, so the UI can show which agency was just connected. */
  verification: Awaited<ReturnType<typeof verifyAgencyToken>>;
}

/**
 * Validate a pasted agency token with a live GHL call, then store it encrypted.
 *
 * Nothing is written until GHL has confirmed the token works, so a typo can never
 * leave a broken credential on file.
 */
export const connectAgency = async (params: {
  privateToken: string;
  relationshipNumber: string;
  actorId?: string;
}): Promise<ConnectAgencyResult> => {
  const verification = await verifyAgencyToken(params.privateToken);

  const existing = await prisma.ghlAgencyConnection.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, companyId: true },
  });

  // The company id is never typed: GoHighLevel reports it for the token. If it
  // cannot (an agency with no sub-accounts yet), keep what we already knew.
  const companyId = verification.companyId ?? existing?.companyId ?? null;

  const data = {
    companyId,
    companyName: verification.companyName,
    relationshipNumber: params.relationshipNumber.trim(),
    tokenEncrypted: encryptPII(params.privateToken.trim()),
    status: IntegrationStatus.CONNECTED,
    lastVerifiedAt: new Date(),
    lastError: null,
    connectedById: params.actorId,
  };

  let connection: GhlAgencyConnectionSafe;
  try {
    connection = existing
      ? await prisma.ghlAgencyConnection.update({
          where: { id: existing.id },
          data,
          select: SAFE_SELECT,
        })
      : await prisma.ghlAgencyConnection.create({ data, select: SAFE_SELECT });
  } catch (error) {
    // companyId is unique: re-connecting a *different* agency that is already on
    // file is a conflict, not a server fault.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ApiError(
        httpStatus.CONFLICT,
        'That GoHighLevel agency is already connected.'
      );
    }
    throw error;
  }

  // Log the linkage, never the credential.
  logger.info(
    `GHL agency connected (companyId=${companyId ?? 'unknown'}, ` +
      `relationshipNumber=${data.relationshipNumber ?? '-'})`
  );

  return { connection, verification };
};

/**
 * Every sub-account under the connected agency, for the `/platform` list.
 * Uses the stored agency credential, falling back to `GHL_AGENCY_PIT`.
 */
export const listSubAccounts = async (options: {
  page?: number;
  limit?: number;
}): Promise<GhlAgencyLocationList> => {
  const token = await ghlTokenProvider.forAgencyConnection();
  const connection = await findLiveConnection();

  return listAgencyLocations(token, {
    companyId: connection?.companyId ?? config.ghl.companyId,
    ...options,
  });
};

export type AgencyEntryResult = { outcome: 'OK' } | { outcome: 'TOKEN_REQUIRED' };

/**
 * Agency admin entry to `/platform`, with no password. The agency is identified
 * by its relationship number.
 *
 * - With a token: it is verified live, stored encrypted against that relationship
 *   number, and the caller is let in.
 * - With only a relationship number: the token saved for it is verified live. A
 *   token GoHighLevel rejects marks the connection as errored and asks for a new
 *   one (`TOKEN_REQUIRED`); an unknown relationship number does the same.
 *
 * A valid agency token can only be minted by an agency admin inside
 * GoHighLevel, so proving possession of one is the credential.
 */
export const enterAgency = async (params: {
  relationshipNumber: string;
  privateToken?: string;
}): Promise<AgencyEntryResult> => {
  const relationshipNumber = params.relationshipNumber.trim();

  if (params.privateToken) {
    await connectAgency({ privateToken: params.privateToken, relationshipNumber });
    return { outcome: 'OK' };
  }

  const stored = await prisma.ghlAgencyConnection.findFirst({
    where: { relationshipNumber },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, companyId: true, tokenEncrypted: true },
  });
  if (!stored?.tokenEncrypted) return { outcome: 'TOKEN_REQUIRED' };

  let plain: string;
  try {
    plain = decryptPII(stored.tokenEncrypted);
  } catch {
    return { outcome: 'TOKEN_REQUIRED' };
  }

  try {
    await listAgencyLocations(ghlTokenProvider.fromAgencyPrivateToken(plain), {
      limit: 1,
      companyId: stored.companyId ?? undefined,
    });
  } catch (error) {
    if (error instanceof GhlApiError && error.isAuthError) {
      await prisma.ghlAgencyConnection.update({
        where: { id: stored.id },
        data: { status: IntegrationStatus.ERROR, lastError: 'Token rejected by GoHighLevel' },
      });
      return { outcome: 'TOKEN_REQUIRED' };
    }
    if (error instanceof GhlApiError && error.status === 0) {
      throw new ApiError(
        httpStatus.BAD_GATEWAY,
        'Could not reach GoHighLevel to verify the saved token. Please try again.'
      );
    }
    throw error;
  }

  await prisma.ghlAgencyConnection.update({
    where: { id: stored.id },
    data: { status: IntegrationStatus.CONNECTED, lastVerifiedAt: new Date(), lastError: null },
  });
  return { outcome: 'OK' };
};
