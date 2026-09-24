import { Prisma } from '@prisma/client';

import prisma from '@/client';
import logger from '@/config/logger';
import { ghlContactIdOf } from '@/shared/services/crm-webhook.service';

import { GhlApiError } from './ghl.client';
import {
  listPipelines,
  searchOpportunities,
  updateOpportunity,
  type GhlOpportunityDto,
} from './ghl.opportunities';
import { classifyStage } from './ghl.stage-map';
import { ghlTokenProvider } from './ghl.tokens';

/**
 * Reconciles a firm's GoHighLevel pipelines and opportunities into our mirror
 * tables. GoHighLevel is the source of truth: anything it no longer has is
 * deleted locally, and any field it reports overwrites ours.
 *
 * Read the mirror tables freely; call `syncFirmOpportunities` to refresh them.
 * Nothing else in the app should talk to the opportunity API directly.
 */

/**
 * How long a sync is considered fresh. Without this, every page load of every
 * tab of every staff member triggers a full walk of the firm's opportunities -
 * which burns the 100-req/10s per-location budget and makes GoHighLevel latency
 * the app's latency. Callers that must bypass it pass `{ force: true }`.
 */
const SYNC_TTL_MS = 60_000;

/** Guards against two concurrent syncs for the same firm doing the same work. */
const inFlight = new Map<string, Promise<SyncResult>>();

export interface SyncResult {
  ranAt: Date;
  /** False when the cached data was still fresh and no GHL call was made. */
  synced: boolean;
  pipelines: number;
  opportunitiesUpserted: number;
  opportunitiesDeleted: number;
  /** Set when the sync could not run; the caller should still serve cached rows. */
  error?: string;
}

const toDate = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Maps GoHighLevel contact ids to our client ids in one pass.
 *
 * `Client.metadata.ghlContactId` is JSON, so it can't be joined on directly -
 * loading the firm's clients once and building a lookup beats an N+1 of JSON
 * queries, one per opportunity.
 */
const buildContactIndex = async (firmId: string): Promise<Map<string, string>> => {
  const clients = await prisma.client.findMany({
    where: { firmId, deletedAt: null },
    select: { id: true, metadata: true },
  });
  const index = new Map<string, string>();
  for (const client of clients) {
    const contactId = ghlContactIdOf(client.metadata);
    if (contactId) index.set(contactId, client.id);
  }
  return index;
};

const isFresh = async (firmId: string): Promise<boolean> => {
  const newest = await prisma.ghlPipeline.findFirst({
    where: { firmId },
    orderBy: { lastSyncedAt: 'desc' },
    select: { lastSyncedAt: true },
  });
  if (!newest) return false;
  return Date.now() - newest.lastSyncedAt.getTime() < SYNC_TTL_MS;
};

const runSync = async (firmId: string): Promise<SyncResult> => {
  const ranAt = new Date();
  const empty: SyncResult = {
    ranAt,
    synced: false,
    pipelines: 0,
    opportunitiesUpserted: 0,
    opportunitiesDeleted: 0,
  };

  let token;
  try {
    token = await ghlTokenProvider.forFirm(firmId);
  } catch (error) {
    // Firm simply isn't connected to GoHighLevel - not an error worth failing
    // the caller's page load over.
    return { ...empty, error: (error as Error).message };
  }

  const locationId = token.locationId as string;

  let remotePipelines;
  try {
    remotePipelines = await listPipelines(token, locationId);
  } catch (error) {
    const message =
      error instanceof GhlApiError
        ? `GoHighLevel pipelines unavailable (${error.status})`
        : (error as Error).message;
    logger.warn(`Opportunity sync skipped for firm ${firmId}: ${message}`);
    return { ...empty, error: message };
  }

  const contactIndex = await buildContactIndex(firmId);

  let upserted = 0;
  let deleted = 0;
  const seenPipelineIds: string[] = [];

  for (const remote of remotePipelines) {
    seenPipelineIds.push(remote.id);

    const pipeline = await prisma.ghlPipeline.upsert({
      where: { firmId_ghlPipelineId: { firmId, ghlPipelineId: remote.id } },
      create: {
        firmId,
        ghlPipelineId: remote.id,
        name: remote.name,
        // Guessed once, on first sight, so the board has a sensible default.
        // Deliberately NOT in `update` - a firm that picks a different document
        // pipeline must not have that choice overwritten on every sync.
        isDocumentPipeline: /document/i.test(remote.name),
        lastSyncedAt: ranAt,
      },
      update: { name: remote.name, lastSyncedAt: ranAt },
    });

    // --- stages -------------------------------------------------------------
    const remoteStages = remote.stages ?? [];
    for (const stage of remoteStages) {
      await prisma.ghlPipelineStage.upsert({
        where: { pipelineId_ghlStageId: { pipelineId: pipeline.id, ghlStageId: stage.id } },
        create: {
          pipelineId: pipeline.id,
          ghlStageId: stage.id,
          name: stage.name,
          position: stage.position ?? 0,
          clientStage: classifyStage(stage.name),
        },
        update: {
          name: stage.name,
          position: stage.position ?? 0,
          // Re-classified every sync so renaming a stage in GoHighLevel
          // immediately corrects what the client portal shows.
          clientStage: classifyStage(stage.name),
        },
      });
    }
    // A stage removed upstream must not linger - opportunities pointing at it
    // are detached by the schema's onDelete: SetNull rather than cascading.
    await prisma.ghlPipelineStage.deleteMany({
      where: { pipelineId: pipeline.id, ghlStageId: { notIn: remoteStages.map((s) => s.id) } },
    });

    const stageRows = await prisma.ghlPipelineStage.findMany({
      where: { pipelineId: pipeline.id },
      select: { id: true, ghlStageId: true },
    });
    const stageByGhlId = new Map(stageRows.map((s) => [s.ghlStageId, s.id]));

    // --- opportunities ------------------------------------------------------
    let remoteOpps: GhlOpportunityDto[];
    try {
      remoteOpps = await searchOpportunities(token, { locationId, pipelineId: remote.id });
    } catch (error) {
      // One bad pipeline shouldn't abort the whole sync; leave its cached rows
      // untouched rather than deleting data we simply failed to read.
      logger.warn(
        `Opportunity fetch failed for pipeline ${remote.id} (firm ${firmId}): ${
          (error as Error).message
        }`
      );
      continue;
    }

    for (const opp of remoteOpps) {
      const stageId = opp.pipelineStageId ? stageByGhlId.get(opp.pipelineStageId) : undefined;
      const contactId = opp.contactId ?? null;
      const data = {
        firmId,
        pipelineId: pipeline.id,
        stageId: stageId ?? null,
        ghlContactId: contactId,
        clientId: contactId ? (contactIndex.get(contactId) ?? null) : null,
        name: opp.name ?? 'Untitled',
        status: opp.status ?? 'open',
        monetaryValue:
          typeof opp.monetaryValue === 'number'
            ? new Prisma.Decimal(opp.monetaryValue)
            : null,
        customFields: (opp.customFields ?? []) as Prisma.InputJsonValue,
        ghlCreatedAt: toDate(opp.createdAt) ?? null,
        ghlUpdatedAt: toDate(opp.updatedAt) ?? null,
        lastSyncedAt: ranAt,
      };

      await prisma.ghlOpportunity.upsert({
        where: { firmId_ghlOpportunityId: { firmId, ghlOpportunityId: opp.id } },
        create: { ghlOpportunityId: opp.id, ...data },
        update: data,
      });
      upserted += 1;
    }

    // GoHighLevel no longer has these -> neither do we. Scoped to this pipeline
    // so a pipeline we failed to fetch above never loses its rows.
    const removed = await prisma.ghlOpportunity.deleteMany({
      where: {
        firmId,
        pipelineId: pipeline.id,
        ghlOpportunityId: { notIn: remoteOpps.map((o) => o.id) },
      },
    });
    deleted += removed.count;
  }

  // Whole pipelines deleted upstream cascade their stages and opportunities.
  const removedPipelines = await prisma.ghlPipeline.deleteMany({
    where: { firmId, ghlPipelineId: { notIn: seenPipelineIds } },
  });

  logger.info(
    `Opportunity sync for firm ${firmId}: ${remotePipelines.length} pipelines, ` +
      `${upserted} opportunities upserted, ${deleted} deleted, ` +
      `${removedPipelines.count} pipelines removed`
  );

  return {
    ranAt,
    synced: true,
    pipelines: remotePipelines.length,
    opportunitiesUpserted: upserted,
    opportunitiesDeleted: deleted,
  };
};

/**
 * Refreshes the mirror for one firm. Cheap to call on every page load: it
 * no-ops while the cache is fresh and collapses concurrent callers onto a
 * single in-flight sync.
 *
 * Never throws - a GoHighLevel outage degrades to serving cached rows, which is
 * what `error` on the result reports.
 */
export const syncFirmOpportunities = async (
  firmId: string,
  options: { force?: boolean } = {}
): Promise<SyncResult> => {
  if (!options.force && (await isFresh(firmId))) {
    return {
      ranAt: new Date(),
      synced: false,
      pipelines: 0,
      opportunitiesUpserted: 0,
      opportunitiesDeleted: 0,
    };
  }

  const existing = inFlight.get(firmId);
  if (existing) return existing;

  const run = runSync(firmId)
    .catch((error) => {
      logger.error(`Opportunity sync crashed for firm ${firmId}: ${(error as Error).message}`);
      return {
        ranAt: new Date(),
        synced: false,
        pipelines: 0,
        opportunitiesUpserted: 0,
        opportunitiesDeleted: 0,
        error: (error as Error).message,
      } satisfies SyncResult;
    })
    .finally(() => inFlight.delete(firmId));

  inFlight.set(firmId, run);
  return run;
};

/**
 * Moves an opportunity to a new stage - the push half of the sync.
 *
 * Writes to GoHighLevel FIRST and only mirrors locally once it confirms. Doing
 * it the other way round would leave our row claiming a stage GoHighLevel
 * rejected, and the next pull would silently revert it with no trace of why.
 */
export const moveOpportunityStage = async (
  firmId: string,
  opportunityId: string,
  targetStageId: string
): Promise<void> => {
  const opportunity = await prisma.ghlOpportunity.findFirst({
    where: { id: opportunityId, firmId },
    include: { pipeline: { select: { id: true, ghlPipelineId: true } } },
  });
  if (!opportunity) {
    throw new GhlApiError('Opportunity not found for this firm', 404);
  }

  const stage = await prisma.ghlPipelineStage.findFirst({
    where: { id: targetStageId, pipelineId: opportunity.pipeline.id },
  });
  if (!stage) {
    throw new GhlApiError('That stage does not belong to this opportunity\'s pipeline', 400);
  }

  const token = await ghlTokenProvider.forFirm(firmId);
  await updateOpportunity(
    token,
    opportunity.ghlOpportunityId,
    { pipelineId: opportunity.pipeline.ghlPipelineId, pipelineStageId: stage.ghlStageId },
    token.locationId
  );

  await prisma.ghlOpportunity.update({
    where: { id: opportunity.id },
    data: { stageId: stage.id, lastSyncedAt: new Date() },
  });
};
