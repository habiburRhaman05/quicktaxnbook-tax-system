import httpStatus from 'http-status';
import { z } from 'zod';

import catchAsync from '@/shared/utils/catch-async';
import zParse from '@/shared/utils/z-parse';
import ApiError from '@/shared/utils/api-error';
import { AuthActor } from '@/types/response';

import { moveOpportunityStage, syncFirmOpportunities } from './ghl.opportunity-sync';
import {
  listClientOpportunities,
  listFirmOpportunities,
  listFirmPipelines,
} from './ghl.opportunity.service';

const listSchema = z.object({
  query: z.object({
    pipelineId: z.string().optional(),
    clientId: z.string().optional(),
    refresh: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  }),
});

const moveStageSchema = z.object({
  params: z.object({ opportunityId: z.string() }),
  body: z.object({ stageId: z.string().min(1, 'A target stage is required') }),
});

/** Staff: every opportunity in the firm. */
export const listOpportunities = catchAsync(async (req) => {
  const { query } = await zParse(listSchema, req);
  const actor = req.user as AuthActor;
  const result = await listFirmOpportunities(actor.firmId as string, {
    pipelineId: query.pipelineId,
    clientId: query.clientId,
    refresh: query.refresh,
  });
  return {
    statusCode: httpStatus.OK,
    message: 'Opportunities fetched successfully',
    data: result,
  };
});

/** Client portal: only the signed-in client's own opportunities. */
export const listMyOpportunities = catchAsync(async (req) => {
  const { query } = await zParse(listSchema, req);
  const actor = req.user as AuthActor;

  // The client id comes from the caller's own access grants, never the query
  // string - a client must not be able to read another client's pipeline by
  // guessing an id.
  const clientId = query.clientId ?? actor.clientIds?.[0];
  if (!clientId || !actor.clientIds?.includes(clientId)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to this client');
  }

  const result = await listClientOpportunities(actor.firmId as string, clientId, {
    refresh: query.refresh,
  });
  return {
    statusCode: httpStatus.OK,
    message: 'Documents fetched successfully',
    data: result,
  };
});

/** Pipelines + stages, for stage pickers in the UI. */
export const listPipelines = catchAsync(async (req) => {
  const actor = req.user as AuthActor;
  const pipelines = await listFirmPipelines(actor.firmId as string);
  return {
    statusCode: httpStatus.OK,
    message: 'Pipelines fetched successfully',
    data: { results: pipelines },
  };
});

/** Explicit "Refresh" button - bypasses the freshness window. */
export const refreshOpportunities = catchAsync(async (req) => {
  const actor = req.user as AuthActor;
  const result = await syncFirmOpportunities(actor.firmId as string, { force: true });
  return {
    statusCode: httpStatus.OK,
    message: result.error ? 'Could not reach GoHighLevel - showing saved data' : 'Synced with GoHighLevel',
    data: result,
  };
});

/** Staff moves a card in our dashboard -> pushed to GoHighLevel. */
export const moveStage = catchAsync(async (req) => {
  const {
    params: { opportunityId },
    body: { stageId },
  } = await zParse(moveStageSchema, req);
  const actor = req.user as AuthActor;
  await moveOpportunityStage(actor.firmId as string, opportunityId, stageId);
  return {
    statusCode: httpStatus.OK,
    message: 'Stage updated in GoHighLevel',
  };
});
