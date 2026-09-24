import { DocumentRequestStatus, Prisma } from '@prisma/client';
import httpStatus from 'http-status';

import prisma, { TX_OPTIONS } from '@/client';
import logger from '@/config/logger';
import { GhlApiError } from '@/modules/ghl/ghl.client';
import { uploadMedia } from '@/modules/ghl/ghl.media';
import { ghlTokenProvider } from '@/modules/ghl/ghl.tokens';
import { ghlContactIdOf } from '@/shared/services/crm-webhook.service';
import { syncDocumentToPipeline, syncRequestToPipeline } from './document.pipeline';
import ApiError from '@/shared/utils/api-error';

/**
 * Client document workflow.
 *
 * Two entry points by design:
 *  - staff create a DocumentRequest ("send me your W-2"), which the client then
 *    fulfils;
 *  - the client uploads something unprompted ("here's my 1099"), which creates
 *    no request at all.
 * Both land in the same place, so the firm sees one list either way.
 *
 * Bytes live in the firm's OWN GoHighLevel sub-account Media Library. Postgres
 * stores the reference, never the file.
 */

const ALLOWED_MIME = new Map<string, string>([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/msword', '.doc'],
]);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const REQUEST_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  isRequired: true,
  dueDate: true,
  createdAt: true,
  receivedAt: true,
  rejectedReason: true,
  clientId: true,
  documents: {
    where: { deletedAt: null },
    select: {
      id: true,
      title: true,
      createdAt: true,
      currentVersion: {
        select: { file: { select: { key: true, originalName: true, sizeBytes: true } } },
      },
    },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

type DocumentRequestRow = Prisma.DocumentRequestGetPayload<{
  select: typeof REQUEST_SELECT;
}>;

/**
 * Maps a request row to JSON-safe output.
 *
 * `sizeBytes` is a Prisma BigInt, and `JSON.stringify` THROWS on BigInt rather
 * than coercing it - returning a raw row here kills the whole response and the
 * UI spins forever with no error. Every path that selects a file must convert.
 */
const presentRequest = (row: DocumentRequestRow) => ({
  ...row,
  documents: row.documents.map((doc) => ({
    ...doc,
    currentVersion: doc.currentVersion
      ? {
          file: {
            ...doc.currentVersion.file,
            sizeBytes: Number(doc.currentVersion.file.sizeBytes),
          },
        }
      : null,
  })),
});

const assertClient = async (firmId: string, clientId: string) => {
  const client = await prisma.client.findFirst({
    where: { id: clientId, firmId, deletedAt: null },
    select: { id: true, displayName: true, metadata: true },
  });
  if (!client) throw new ApiError(httpStatus.NOT_FOUND, 'Client not found');
  return client;
};

// ---------------------------------------------------------------------------
// Staff: request a document from a client
// ---------------------------------------------------------------------------

export interface CreateRequestInput {
  clientId: string;
  title: string;
  description?: string;
  isRequired?: boolean;
  dueDate?: Date;
}

export const createDocumentRequest = async (
  firmId: string,
  createdById: string,
  input: CreateRequestInput
) => {
  await assertClient(firmId, input.clientId);

  const created = await prisma.documentRequest.create({
    data: {
      firmId,
      clientId: input.clientId,
      title: input.title,
      description: input.description,
      isRequired: input.isRequired ?? true,
      dueDate: input.dueDate,
      createdById,
      status: DocumentRequestStatus.MISSING,
    },
    select: REQUEST_SELECT,
  });

  // Fire-and-forget: the request is saved; a GoHighLevel hiccup must not fail
  // the staff member's action. The board reconciles on next sync either way.
  void syncRequestToPipeline(firmId, input.clientId);

  return presentRequest(created);
};

/** Staff view of one client's checklist. */
export const listRequestsForClient = async (firmId: string, clientId: string) => {
  await assertClient(firmId, clientId);
  const rows = await prisma.documentRequest.findMany({
    where: { firmId, clientId, deletedAt: null },
    select: REQUEST_SELECT,
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(presentRequest);
};

/** Client portal view - scoped to the caller's own client id. */
export const listMyRequests = async (clientId: string) => {
  const rows = await prisma.documentRequest.findMany({
    where: { clientId, deletedAt: null, isClientVisible: true },
    select: REQUEST_SELECT,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(presentRequest);
};

/** Staff accept/reject an uploaded document against its request. */
export const reviewRequest = async (
  firmId: string,
  requestId: string,
  reviewedById: string,
  decision: { status: 'RECEIVED' | 'REJECTED'; reason?: string }
) => {
  const request = await prisma.documentRequest.findFirst({
    where: { id: requestId, firmId, deletedAt: null },
    select: { id: true },
  });
  if (!request) throw new ApiError(httpStatus.NOT_FOUND, 'Document request not found');

  const updated = await prisma.documentRequest.update({
    where: { id: requestId },
    data: {
      status: decision.status as DocumentRequestStatus,
      reviewedById,
      receivedAt: decision.status === 'RECEIVED' ? new Date() : null,
      rejectedReason: decision.status === 'REJECTED' ? decision.reason : null,
    },
    select: REQUEST_SELECT,
  });
  return presentRequest(updated);
};

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadInput {
  clientId: string;
  /** Set when fulfilling a staff request; omitted for an unprompted upload. */
  requestId?: string;
  title?: string;
  clientNote?: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  uploadedById?: string;
  uploadIp?: string;
}

/** `{contactId}_{name}_{timestamp}.{ext}` - keeps files identifiable in GHL. */
const buildFileName = (contactId: string, originalName: string, mimeType: string): string => {
  const ext = ALLOWED_MIME.get(mimeType) ?? '';
  const base = originalName
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'document';
  return `${contactId}_${base}_${Date.now()}${ext}`;
};

export const uploadClientDocument = async (firmId: string, input: UploadInput) => {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Only PDF, JPG, PNG, DOC or DOCX files are allowed');
  }
  if (input.buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Files must be 10MB or smaller');
  }

  const client = await assertClient(firmId, input.clientId);

  // A request, when given, must belong to this same client - otherwise a
  // client could attach a file to another client's checklist item.
  if (input.requestId) {
    const request = await prisma.documentRequest.findFirst({
      where: { id: input.requestId, firmId, clientId: input.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!request) throw new ApiError(httpStatus.NOT_FOUND, 'Document request not found');
  }

  const contactId = ghlContactIdOf(client.metadata) ?? client.id;

  let token;
  try {
    token = await ghlTokenProvider.forFirm(firmId);
  } catch {
    throw new ApiError(
      httpStatus.CONFLICT,
      'This firm is not connected to GoHighLevel yet, so documents cannot be stored'
    );
  }

  const fileName = buildFileName(contactId, input.originalName, input.mimeType);

  // Upload BEFORE writing any row: if GoHighLevel rejects the file there must
  // be no database record claiming a document that was never stored.
  const media = await uploadMedia({
    token,
    locationId: token.locationId as string,
    fileName,
    mimeType: input.mimeType,
    buffer: input.buffer,
  });

  const document = await prisma.$transaction(async (tx) => {
    const storedFile = await tx.storedFile.create({
      data: {
        firmId,
        provider: 'GHL_MEDIA',
        bucket: token.locationId as string,
        key: media.url || `ghl://${token.locationId}/${media.fileId}`,
        externalFileId: media.fileId || null,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.buffer.byteLength),
        virusScanStatus: 'SKIPPED',
        uploadedById: input.uploadedById,
        uploadIp: input.uploadIp,
      },
    });

    const created = await tx.document.create({
      data: {
        firmId,
        clientId: input.clientId,
        requestId: input.requestId,
        title: input.title?.trim() || input.originalName,
        clientNote: input.clientNote,
        kind: 'CLIENT_SOURCE',
        visibility: 'CLIENT_VISIBLE',
        versionCount: 1,
      },
    });

    const version = await tx.documentVersion.create({
      data: {
        documentId: created.id,
        versionNumber: 1,
        fileId: storedFile.id,
        uploadedById: input.uploadedById,
        uploadedVia: 'PORTAL',
      },
    });

    await tx.document.update({
      where: { id: created.id },
      data: { currentVersionId: version.id },
    });

    // Fulfilling a request flips it to UPLOADED - staff still accept/reject it.
    if (input.requestId) {
      await tx.documentRequest.update({
        where: { id: input.requestId },
        data: { status: DocumentRequestStatus.UPLOADED },
      });
    }

    return created;
  }, TX_OPTIONS);

  // Advance the client's card to "Documents Received". Best-effort by design -
  // the file is already stored, so a CRM failure must not fail the upload.
  void syncDocumentToPipeline(firmId, input.clientId);

  return {
    id: document.id,
    title: document.title,
    fileUrl: media.url,
    fileId: media.fileId,
    requestId: input.requestId ?? null,
    createdAt: document.createdAt,
  };
};

/** Every document for a client, newest first. Used by staff and the portal. */
export const listDocuments = async (firmId: string, clientId: string) => {
  const documents = await prisma.document.findMany({
    where: { firmId, clientId, deletedAt: null },
    select: {
      id: true,
      title: true,
      clientNote: true,
      kind: true,
      createdAt: true,
      requestId: true,
      request: { select: { id: true, title: true, status: true } },
      currentVersion: {
        select: {
          uploadedVia: true,
          file: {
            select: { key: true, originalName: true, mimeType: true, sizeBytes: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return documents.map((doc) => ({
    id: doc.id,
    title: doc.title,
    clientNote: doc.clientNote,
    requestId: doc.requestId,
    requestTitle: doc.request?.title ?? null,
    requestStatus: doc.request?.status ?? null,
    fileUrl: doc.currentVersion?.file.key ?? null,
    originalName: doc.currentVersion?.file.originalName ?? null,
    mimeType: doc.currentVersion?.file.mimeType ?? null,
    // BigInt can't be JSON-serialized - send a number the UI can format.
    sizeBytes: doc.currentVersion?.file.sizeBytes
      ? Number(doc.currentVersion.file.sizeBytes)
      : null,
    createdAt: doc.createdAt,
  }));
};

/** Non-fatal: a GHL failure here must not fail an upload that already landed. */
export const logGhlFailure = (context: string, error: unknown): void => {
  const message =
    error instanceof GhlApiError
      ? `${error.message} (status ${error.status})`
      : (error as Error).message;
  logger.error(`${context}: ${message}`);
};

