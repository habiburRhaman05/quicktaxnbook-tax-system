'use client';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Fragment, useMemo, useState } from 'react';

import { Icon } from '@/components/icons/app-icons';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader, PageLayout } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useMoveStage,
  useOpportunities,
  usePipelines,
  useRefreshOpportunities,
} from '@/features/opportunities/hooks/use-opportunities';
import {
  CLIENT_STAGE_LABELS,
  CLIENT_STAGE_STYLES,
  type Opportunity,
  type PipelineWithStages,
} from '@/features/opportunities/types';
import { cn } from '@/libs/utils';

function StageBadge({ opportunity }: { opportunity: Opportunity }) {
  if (!opportunity.stage) return null;
  const bucket = opportunity.stage.clientStage;
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px] font-medium', CLIENT_STAGE_STYLES[bucket])}
    >
      {CLIENT_STAGE_LABELS[bucket]}
    </Badge>
  );
}

/** One draggable opportunity card. */
function OpportunityCard({
  opportunity,
  overlay = false,
}: {
  opportunity: Opportunity;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: opportunity.id,
    data: { opportunity },
  });

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      className={cn(
        'cursor-grab touch-none rounded-md border border-border bg-card p-3 shadow-sm',
        'hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // The original stays in place but muted while its overlay follows the
        // cursor - without this the column visibly collapses mid-drag.
        isDragging && !overlay && 'opacity-40',
        overlay && 'cursor-grabbing rotate-2 shadow-lg',
      )}
    >
      <div className="mb-1.5 line-clamp-2 text-sm font-medium text-foreground">
        {opportunity.name}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StageBadge opportunity={opportunity} />
        {!opportunity.clientId && (
          <Badge
            variant="outline"
            className="border-dashed text-[10px] text-muted-foreground"
            title="This GoHighLevel contact isn't linked to a client in this app yet, so the client can't see it in their portal."
          >
            Unlinked
          </Badge>
        )}
      </div>
      {opportunity.updatedAt && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Updated {new Date(opportunity.updatedAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

/** One stage column, which is also a drop target. */
function StageColumn({
  stage,
  opportunities,
}: {
  stage: PipelineWithStages['stages'][number];
  opportunities: Opportunity[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            {stage.name}
          </span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {opportunities.length}
          </span>
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[8rem] flex-1 flex-col gap-2 rounded-lg border border-dashed border-transparent bg-muted/30 p-2 transition-colors',
          isOver && 'border-primary/50 bg-primary/5',
        )}
      >
        {opportunities.map((opp) => (
          <OpportunityCard key={opp.id} opportunity={opp} />
        ))}
        {opportunities.length === 0 && (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            Drop here
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * `embedded` renders the board without its own PageLayout/PageHeader, for use
 * inside a tab that already provides them.
 */
export function OpportunityBoard({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: pipelines, isPending: pipelinesPending } = usePipelines();
  const [pipelineId, setPipelineId] = useState<string | undefined>();

  // Default to the firm's document pipeline, else the first one.
  const activePipeline = useMemo<PipelineWithStages | undefined>(() => {
    if (!pipelines?.length) return undefined;
    if (pipelineId) return pipelines.find((p) => p.id === pipelineId);
    return pipelines.find((p) => p.isDocumentPipeline) ?? pipelines[0];
  }, [pipelines, pipelineId]);

  const { data, isPending } = useOpportunities(activePipeline?.id);
  const refresh = useRefreshOpportunities();
  const moveStage = useMoveStage();
  const [dragging, setDragging] = useState<Opportunity | null>(null);

  const byStage = useMemo(() => {
    const map = new Map<string, Opportunity[]>();
    for (const stage of activePipeline?.stages ?? []) map.set(stage.id, []);
    for (const opp of data?.results ?? []) {
      if (!opp.stage) continue;
      map.get(opp.stage.id)?.push(opp);
    }
    return map;
  }, [data, activePipeline]);

  const sensors = useSensors(
    // A small distance threshold so a click to open a card isn't swallowed as
    // the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (event: DragStartEvent) => {
    setDragging((event.active.data.current?.opportunity as Opportunity) ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;

    const opportunity = active.data.current?.opportunity as Opportunity | undefined;
    const targetStageId = String(over.id);
    // Dropping a card back where it started is a no-op, not a pointless
    // round trip to GoHighLevel.
    if (!opportunity || opportunity.stage?.id === targetStageId) return;

    moveStage.mutate({
      opportunityId: opportunity.id,
      stageId: targetStageId,
      pipelineId: activePipeline?.id,
    });
  };

  const loading = pipelinesPending || isPending;

  const Wrapper = embedded ? Fragment : PageLayout;

  // Pipeline picker + Refresh. Rendered inside the PageHeader when standalone,
  // and as its own toolbar when embedded - either way the controls are present.
  const controls = (
    <div className="flex items-center gap-2">
      {pipelines && pipelines.length > 1 && (
        <Select
          value={activePipeline?.id}
          onValueChange={(value) => setPipelineId(value)}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Select pipeline" />
          </SelectTrigger>
          <SelectContent>
            {pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        variant="outline"
        onClick={() => refresh.mutate()}
        loading={refresh.isPending}
      >
        <Icon name="refresh" className="h-4 w-4" /> Refresh
      </Button>
    </div>
  );

  return (
    <Wrapper>
      {embedded ? (
        <div className="mb-4 flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Drag a card to move it - the change is pushed back to GoHighLevel.
          </p>
          {controls}
        </div>
      ) : (
        <PageHeader
          title="Document pipeline"
          subtitle="Synced from GoHighLevel. Drag a card to move it - the change is pushed back to your CRM."
          actions={controls}
        />
      )}

      {data?.sync.degraded && (
        <div
          role="status"
          className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
        >
          Showing saved data - couldn&apos;t reach GoHighLevel.
          {data.sync.message ? ` (${data.sync.message})` : ''}
        </div>
      )}

      {loading ? (
        <div className="flex gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64 w-72 shrink-0" />
          ))}
        </div>
      ) : !activePipeline ? (
        <Card flat className="overflow-hidden py-0">
          <EmptyState
            icon="folder"
            title="No pipelines found"
            description="Connect this firm to a GoHighLevel sub-account, then hit Refresh."
          />
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className="flex gap-4 overflow-x-auto pb-4">
            {[...activePipeline.stages]
              .sort((a, b) => a.position - b.position)
              .map((stage) => (
                <StageColumn
                  key={stage.id}
                  stage={stage}
                  opportunities={byStage.get(stage.id) ?? []}
                />
              ))}
          </div>

          {/* Follows the cursor so the card stays visible across columns. */}
          <DragOverlay>
            {dragging ? <OpportunityCard opportunity={dragging} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}
    </Wrapper>
  );
}
