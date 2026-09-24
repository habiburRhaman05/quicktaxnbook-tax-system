import httpStatus from 'http-status';

import ApiError from '@/shared/utils/api-error';
import catchAsync from '@/shared/utils/catch-async';
import zParse from '@/shared/utils/z-parse';
import { AuthActor } from '@/types/response';

import * as documentService from './document.service';
import * as documentSchema from './document.validation';

/**
 * Resolves which client the CALLER may act on.
 *
 * Staff pass a clientId and it is checked against their firm. A portal client
 * may only ever act on a client id in their own access grants - never one
 * supplied in the request body, or one client could upload into another's file
 * list by guessing an id.
 */
const resolveClientId = (actor: AuthActor, requested?: string): string => {
  if (actor.accountRole === 'FIRM_CLIENT') {
    const allowed = actor.clientIds ?? [];
    const clientId = requested ?? allowed[0];
    if (!clientId || !allowed.includes(clientId)) {
      throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to this client');
    }
    return clientId;
  }
  if (!requested) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A client is required');
  }
  return requested;
};

// --- Staff -----------------------------------------------------------------

export const createRequest = catchAsync(async (req) => {
  const { body } = await zParse(documentSchema.createRequestSchema, req);
  const actor = req.user as AuthActor;
  const request = await documentService.createDocumentRequest(
    actor.firmId as string,
    actor.userId,
    body
  );
  return {
    statusCode: httpStatus.CREATED,
    message: 'Document requested from client',
    data: request,
  };
});

export const listClientRequests = catchAsync(async (req) => {
  const {
    params: { clientId },
  } = await zParse(documentSchema.clientIdParamSchema, req);
  const actor = req.user as AuthActor;
  const results = await documentService.listRequestsForClient(actor.firmId as string, clientId);
  return {
    statusCode: httpStatus.OK,
    message: 'Document requests fetched successfully',
    data: { results },
  };
});

export const listClientDocuments = catchAsync(async (req) => {
  const {
    params: { clientId },
  } = await zParse(documentSchema.clientIdParamSchema, req);
  const actor = req.user as AuthActor;
  const results = await documentService.listDocuments(actor.firmId as string, clientId);
  return {
    statusCode: httpStatus.OK,
    message: 'Documents fetched successfully',
    data: { results },
  };
});

export const reviewRequest = catchAsync(async (req) => {
  const {
    params: { requestId },
    body,
  } = await zParse(documentSchema.reviewRequestSchema, req);
  const actor = req.user as AuthActor;
  const request = await documentService.reviewRequest(
    actor.firmId as string,
    requestId,
    actor.userId,
    body
  );
  return {
    statusCode: httpStatus.OK,
    message: body.status === 'RECEIVED' ? 'Document accepted' : 'Document rejected',
    data: request,
  };
});

// --- Client portal ----------------------------------------------------------

export const listMyRequests = catchAsync(async (req) => {
  const actor = req.user as AuthActor;
  const clientId = resolveClientId(actor, req.query.clientId as string | undefined);
  const results = await documentService.listMyRequests(clientId);
  return {
    statusCode: httpStatus.OK,
    message: 'Document requests fetched successfully',
    data: { results },
  };
});

export const listMyDocuments = catchAsync(async (req) => {
  const actor = req.user as AuthActor;
  const clientId = resolveClientId(actor, req.query.clientId as string | undefined);
  const results = await documentService.listDocuments(actor.firmId as string, clientId);
  return {
    statusCode: httpStatus.OK,
    message: 'Documents fetched successfully',
    data: { results },
  };
});

// --- Upload (staff or client) ----------------------------------------------

export const uploadDocument = catchAsync(async (req) => {
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No file was uploaded');
  }

  const { body } = await zParse(documentSchema.uploadSchema, req);
  const actor = req.user as AuthActor;
  const clientId = resolveClientId(actor, body.clientId);

  const result = await documentService.uploadClientDocument(actor.firmId as string, {
    clientId,
    requestId: body.requestId || undefined,
    title: body.title,
    clientNote: body.clientNote,
    originalName: file.originalname,
    mimeType: file.mimetype,
    buffer: file.buffer,
    uploadedById: actor.userId,
    uploadIp: req.ip,
  });

  return {
    statusCode: httpStatus.CREATED,
    message: 'Document uploaded successfully',
    data: result,
  };
});
