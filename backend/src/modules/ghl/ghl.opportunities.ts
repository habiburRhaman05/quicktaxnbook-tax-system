import { ghlRequest } from './ghl.client';
import type { GhlToken } from './ghl.types';

/**
 * GoHighLevel opportunity + pipeline reads/writes.
 *
 * Every function here takes an explicit sub-account (`location`) token - the
 * agency token must never be used for these, because opportunities live inside
 * a single sub-account and an agency-scoped call would cross tenants.
 */

export interface GhlStage {
  id: string;
  name: string;
  position?: number;
}

export interface GhlPipelineDto {
  id: string;
  name: string;
  stages?: GhlStage[];
}

export interface GhlOpportunityDto {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  contactId?: string;
  status?: string;
  monetaryValue?: number | null;
  createdAt?: string;
  updatedAt?: string;
  customFields?: Array<{ id?: string; key?: string; fieldValue?: unknown; value?: unknown }>;
  [key: string]: unknown;
}

/** `GET /opportunities/pipelines` - every pipeline in the sub-account. */
export const listPipelines = async (
  token: GhlToken,
  locationId: string
): Promise<GhlPipelineDto[]> => {
  const { data } = await ghlRequest<{ pipelines?: GhlPipelineDto[] }>({
    path: '/opportunities/pipelines',
    token,
    query: { locationId },
    concurrencyKey: locationId,
  });
  return data?.pipelines ?? [];
};

/** Hard cap so one sync can never walk an unbounded opportunity list. */
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

/**
 * `GET /opportunities/search` - every opportunity in a pipeline.
 *
 * Paginates via `startAfter`/`startAfterId` (GoHighLevel's cursor pair) rather
 * than page numbers, which drift when records change mid-walk. Stops at
 * MAX_PAGES so a runaway tenant can't stall the request forever.
 */
export const searchOpportunities = async (
  token: GhlToken,
  params: { locationId: string; pipelineId?: string; contactId?: string }
): Promise<GhlOpportunityDto[]> => {
  const all: GhlOpportunityDto[] = [];
  let startAfter: string | undefined;
  let startAfterId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await ghlRequest<{
      opportunities?: GhlOpportunityDto[];
      meta?: { startAfter?: string; startAfterId?: string };
    }>({
      path: '/opportunities/search',
      token,
      concurrencyKey: params.locationId,
      query: {
        location_id: params.locationId,
        ...(params.pipelineId ? { pipeline_id: params.pipelineId } : {}),
        ...(params.contactId ? { contact_id: params.contactId } : {}),
        limit: PAGE_SIZE,
        ...(startAfter ? { startAfter } : {}),
        ...(startAfterId ? { startAfterId } : {}),
      },
    });

    const batch = data?.opportunities ?? [];
    all.push(...batch);

    // A short page means we've reached the end; no cursor means we can't go on.
    if (batch.length < PAGE_SIZE) break;
    startAfter = data?.meta?.startAfter;
    startAfterId = data?.meta?.startAfterId;
    if (!startAfter || !startAfterId) break;
  }

  return all;
};

export interface CreateOpportunityInput {
  locationId: string;
  pipelineId: string;
  pipelineStageId: string;
  contactId: string;
  name: string;
  status?: string;
}

/** `POST /opportunities` - one opportunity per client engagement. */
export const createOpportunity = async (
  token: GhlToken,
  input: CreateOpportunityInput
): Promise<GhlOpportunityDto> => {
  const { data } = await ghlRequest<{ opportunity?: GhlOpportunityDto }>({
    path: '/opportunities/',
    method: 'POST',
    token,
    concurrencyKey: input.locationId,
    body: {
      locationId: input.locationId,
      pipelineId: input.pipelineId,
      pipelineStageId: input.pipelineStageId,
      contactId: input.contactId,
      name: input.name,
      status: input.status ?? 'open',
    },
  });
  return (data?.opportunity ?? data) as GhlOpportunityDto;
};

/**
 * `PUT /opportunities/:id` - the push half of the two-way sync.
 *
 * Only the fields given are sent, so moving a card's stage never clobbers a
 * value (owner, monetary value, custom field) a staff member set in GoHighLevel.
 */
export const updateOpportunity = async (
  token: GhlToken,
  opportunityId: string,
  patch: { pipelineId?: string; pipelineStageId?: string; name?: string; status?: string },
  concurrencyKey?: string
): Promise<GhlOpportunityDto> => {
  const { data } = await ghlRequest<{ opportunity?: GhlOpportunityDto }>({
    path: `/opportunities/${opportunityId}`,
    method: 'PUT',
    token,
    concurrencyKey: concurrencyKey ?? token.locationId,
    body: patch,
  });
  return (data?.opportunity ?? data) as GhlOpportunityDto;
};
