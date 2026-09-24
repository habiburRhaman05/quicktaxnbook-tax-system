import { ClientDocStage } from '@prisma/client';

import prisma from '@/client';
import logger from '@/config/logger';
import {
  createOpportunity,
  listPipelines,
  updateOpportunity,
} from '@/modules/ghl/ghl.opportunities';
import { classifyStage } from '@/modules/ghl/ghl.stage-map';
import { ghlTokenProvider } from '@/modules/ghl/ghl.tokens';

/**
 * Keeps the GoHighLevel opportunity for a client's engagement in step with
 * their documents - this is what makes cards appear on the pipeline board.
 *
 * One opportunity per CLIENT, not per file: you e-sign and invoice a return,
 * not each uploaded W-2. Uploading more documents moves that one card forward
 * rather than creating a pile of new ones.
 *
 * Every function here is best-effort. A document that is already stored must
 * never be lost because GoHighLevel was unreachable, so failures are logged
 * and swallowed; the next sync reconciles.
 */

/** The pipeline documents are tracked in, preferring one flagged by the firm. */
const resolveDocumentPipeline = async (firmId: string) => {
  const flagged = await prisma.ghlPipeline.findFirst({
    where: { firmId, isDocumentPipeline: true },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
  if (flagged) return flagged;

  // Fall back to a pipeline that actually looks like a document workflow,
  // rather than grabbing whichever pipeline happens to sort first.
  return prisma.ghlPipeline.findFirst({
    where: { firmId, name: { contains: 'Document', mode: 'insensitive' } },
    include: { stages: { orderBy: { position: 'asc' } } },
  });
};

/** First stage matching a client-facing bucket, else the earliest stage. */
const stageFor = (
  stages: Array<{ id: string; ghlStageId: string; clientStage: ClientDocStage; position: number }>,
  target: ClientDocStage
) => stages.find((s) => s.clientStage === target) ?? stages[0];

/**
 * Ensures the firm's pipelines are mirrored locally.
 *
 * A firm that has never opened the board has no `GhlPipeline` rows yet, so an
 * upload would silently have nowhere to put its card. Pull them on demand.
 */
const ensurePipelinesMirrored = async (firmId: string): Promise<void> => {
  const existing = await prisma.ghlPipeline.count({ where: { firmId } });
  if (existing > 0) return;

  const token = await ghlTokenProvider.forFirm(firmId);
  const locationId = token.locationId as string;
  const remote = await listPipelines(token, locationId);

  for (const pipeline of remote) {
    const row = await prisma.ghlPipeline.upsert({
      where: { firmId_ghlPipelineId: { firmId, ghlPipelineId: pipeline.id } },
      create: {
        firmId,
        ghlPipelineId: pipeline.id,
        name: pipeline.name,
        isDocumentPipeline: /document/i.test(pipeline.name),
      },
      update: { name: pipeline.name },
    });
    for (const stage of pipeline.stages ?? []) {
      await prisma.ghlPipelineStage.upsert({
        where: { pipelineId_ghlStageId: { pipelineId: row.id, ghlStageId: stage.id } },
        create: {
          pipelineId: row.id,
          ghlStageId: stage.id,
          name: stage.name,
          position: stage.position ?? 0,
          clientStage: classifyStage(stage.name),
        },
        update: {
          name: stage.name,
          position: stage.position ?? 0,
          clientStage: classifyStage(stage.name),
        },
      });
    }
  }
};

/**
 * Called after a document is stored. Creates the client's opportunity if it
 * doesn't exist, otherwise advances it to "Documents Received".
 */
export const syncDocumentToPipeline = async (
  firmId: string,
  clientId: string,
  targetStage: ClientDocStage = ClientDocStage.RECEIVED
): Promise<void> => {
  try {
    await ensurePipelinesMirrored(firmId);

    const pipeline = await resolveDocumentPipeline(firmId);
    if (!pipeline || pipeline.stages.length === 0) {
      logger.warn(`No document pipeline mirrored for firm ${firmId} - skipping card update`);
      return;
    }

    const client = await prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { id: true, displayName: true, metadata: true },
    });
    const ghlContactId = (client.metadata as { ghlContactId?: string } | null)?.ghlContactId;
    if (!ghlContactId) {
      // Without a GoHighLevel contact there is nothing to hang an opportunity
      // on. The document is still stored and visible in this app.
      logger.warn(`Client ${clientId} has no GoHighLevel contact - skipping opportunity`);
      return;
    }

    const stage = stageFor(pipeline.stages, targetStage);
    if (!stage) return;

    const token = await ghlTokenProvider.forFirm(firmId);
    const locationId = token.locationId as string;

    const existing = await prisma.ghlOpportunity.findFirst({
      where: { firmId, clientId, pipelineId: pipeline.id },
    });

    if (existing) {
      // Never drag a card BACKWARDS. If staff have already moved this
      // engagement to "In Preparation", a newly uploaded document must not
      // reset it to "Documents Received".
      const currentStage = existing.stageId
        ? pipeline.stages.find((s) => s.id === existing.stageId)
        : undefined;
      if (currentStage && currentStage.position >= stage.position) return;

      await updateOpportunity(
        token,
        existing.ghlOpportunityId,
        { pipelineId: pipeline.ghlPipelineId, pipelineStageId: stage.ghlStageId },
        locationId
      );
      await prisma.ghlOpportunity.update({
        where: { id: existing.id },
        data: { stageId: stage.id, lastSyncedAt: new Date() },
      });
      return;
    }

    const created = await createOpportunity(token, {
      locationId,
      pipelineId: pipeline.ghlPipelineId,
      pipelineStageId: stage.ghlStageId,
      contactId: ghlContactId,
      name: client.displayName,
    });

    await prisma.ghlOpportunity.upsert({
      where: { firmId_ghlOpportunityId: { firmId, ghlOpportunityId: created.id } },
      create: {
        firmId,
        ghlOpportunityId: created.id,
        pipelineId: pipeline.id,
        stageId: stage.id,
        ghlContactId,
        clientId,
        name: client.displayName,
        status: 'open',
        lastSyncedAt: new Date(),
      },
      update: { stageId: stage.id, clientId, lastSyncedAt: new Date() },
    });
  } catch (error) {
    logger.error(
      `Pipeline sync failed for client ${clientId} (firm ${firmId}): ${(error as Error).message}`
    );
  }
};

/**
 * Creates the card when staff REQUEST a document, so the engagement appears on
 * the board at "Document Requested" before the client has uploaded anything.
 */
export const syncRequestToPipeline = (firmId: string, clientId: string): Promise<void> =>
  syncDocumentToPipeline(firmId, clientId, ClientDocStage.REQUESTED);
