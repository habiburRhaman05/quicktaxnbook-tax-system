import type { Prisma } from '@prisma/client';

import prisma from '@/client';

import { CLIENT_STAGE_LABELS } from './ghl.stage-map';
import { syncFirmOpportunities, type SyncResult } from './ghl.opportunity-sync';

/**
 * Read side of the opportunity mirror. Always serves from our tables - the
 * refresh is triggered alongside, never awaited in a way that makes a
 * GoHighLevel outage look like an app outage.
 */

const OPPORTUNITY_SELECT = {
  id: true,
  ghlOpportunityId: true,
  name: true,
  status: true,
  ghlContactId: true,
  clientId: true,
  ghlCreatedAt: true,
  ghlUpdatedAt: true,
  lastSyncedAt: true,
  stage: { select: { id: true, name: true, position: true, clientStage: true } },
  pipeline: {
    select: { id: true, name: true, ghlPipelineId: true, isDocumentPipeline: true },
  },
} as const;

type OpportunityRow = Prisma.GhlOpportunityGetPayload<{ select: typeof OPPORTUNITY_SELECT }>;

const present = (row: OpportunityRow) => ({
  id: row.id,
  ghlOpportunityId: row.ghlOpportunityId,
  name: row.name,
  status: row.status,
  clientId: row.clientId,
  ghlContactId: row.ghlContactId,
  pipeline: row.pipeline,
  stage: row.stage
    ? {
        id: row.stage.id,
        name: row.stage.name,
        position: row.stage.position,
        clientStage: row.stage.clientStage,
        // The firm's own stage name is kept alongside the rolled-up bucket so
        // staff see their CRM wording while the client sees ours.
        clientLabel: CLIENT_STAGE_LABELS[row.stage.clientStage],
      }
    : null,
  createdAt: row.ghlCreatedAt,
  updatedAt: row.ghlUpdatedAt,
  lastSyncedAt: row.lastSyncedAt,
});

export interface ListOpportunitiesOptions {
  pipelineId?: string;
  clientId?: string;
  /** Skip the freshness window and pull from GoHighLevel now. */
  refresh?: boolean;
}

/** Staff view: every opportunity in the firm, optionally filtered. */
export const listFirmOpportunities = async (
  firmId: string,
  options: ListOpportunitiesOptions = {}
) => {
  const sync = await syncFirmOpportunities(firmId, { force: options.refresh });

  const results = await prisma.ghlOpportunity.findMany({
    where: {
      firmId,
      ...(options.pipelineId ? { pipelineId: options.pipelineId } : {}),
      ...(options.clientId ? { clientId: options.clientId } : {}),
    },
    select: OPPORTUNITY_SELECT,
    orderBy: [{ ghlUpdatedAt: 'desc' }, { createdAt: 'desc' }],
  });

  return { results: results.map(present), sync: summarize(sync) };
};

/**
 * Client portal view: only the signed-in client's own opportunities.
 * Scoped by `clientId` on the row, never by a caller-supplied filter.
 */
export const listClientOpportunities = async (
  firmId: string,
  clientId: string,
  options: { refresh?: boolean } = {}
) => {
  const sync = await syncFirmOpportunities(firmId, { force: options.refresh });

  const results = await prisma.ghlOpportunity.findMany({
    where: { firmId, clientId },
    select: OPPORTUNITY_SELECT,
    orderBy: [{ ghlUpdatedAt: 'desc' }, { createdAt: 'desc' }],
  });

  return { results: results.map(present), sync: summarize(sync) };
};

/** Pipelines + stages for pickers, so the UI never hard-codes stage ids. */
export const listFirmPipelines = async (firmId: string) => {
  return prisma.ghlPipeline.findMany({
    where: { firmId },
    select: {
      id: true,
      ghlPipelineId: true,
      name: true,
      isDocumentPipeline: true,
      lastSyncedAt: true,
      stages: {
        select: { id: true, ghlStageId: true, name: true, position: true, clientStage: true },
        orderBy: { position: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });
};

/** Log-safe sync summary surfaced to the UI so it can show "synced 2m ago". */
const summarize = (sync: SyncResult) => ({
  ranAt: sync.ranAt,
  synced: sync.synced,
  // Present so the dashboard can show "showing cached data" instead of
  // pretending everything is current when GoHighLevel was unreachable.
  degraded: !!sync.error,
  message: sync.error,
});
