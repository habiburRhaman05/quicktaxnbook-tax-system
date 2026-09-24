'use client';

import { Icon } from '@/components/icons/app-icons';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMyDocuments } from '@/features/opportunities/hooks/use-opportunities';
import {
  CLIENT_STAGE_LABELS,
  CLIENT_STAGE_ORDER,
  type ClientDocStage,
  type Opportunity,
} from '@/features/opportunities/types';
import { cn } from '@/libs/utils';

/**
 * Client-facing "where is my work at" view.
 *
 * Reads the SAME opportunity the staff pipeline board and GoHighLevel share -
 * this is deliberately not a separate status, so what the client sees here can
 * never drift from what staff see on the board.
 */

function StepIcon({
  index,
  currentIndex,
}: {
  index: number;
  currentIndex: number;
}) {
  if (index < currentIndex) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Icon name="check" className="h-4 w-4" />
      </div>
    );
  }
  if (index === currentIndex) {
    return (
      <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary bg-primary/10">
        <span className="h-2.5 w-2.5 rounded-full bg-primary" />
      </div>
    );
  }
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-border bg-muted" />
  );
}

function Stepper({ stage }: { stage: ClientDocStage }) {
  const currentIndex = CLIENT_STAGE_ORDER.indexOf(stage);

  return (
    <div
      className="flex items-start"
      role="img"
      aria-label={`Step ${currentIndex + 1} of ${CLIENT_STAGE_ORDER.length}: ${CLIENT_STAGE_LABELS[stage]}`}
    >
      {CLIENT_STAGE_ORDER.map((step, index) => (
        <div
          key={step}
          className={cn(
            'flex flex-1 flex-col items-center text-center',
            index === CLIENT_STAGE_ORDER.length - 1 && 'flex-none',
          )}
        >
          <div className="flex w-full items-center">
            {/* Connector before the dot - skipped for the first step. */}
            <div
              className={cn(
                'h-0.5 flex-1',
                index === 0
                  ? 'invisible'
                  : index <= currentIndex
                    ? 'bg-primary'
                    : 'bg-border',
              )}
            />
            <StepIcon index={index} currentIndex={currentIndex} />
            <div
              className={cn(
                'h-0.5 flex-1',
                index === CLIENT_STAGE_ORDER.length - 1
                  ? 'invisible'
                  : index < currentIndex
                    ? 'bg-primary'
                    : 'bg-border',
              )}
            />
          </div>
          <span
            className={cn(
              'mt-2 max-w-20 text-[11px] leading-tight',
              index === currentIndex
                ? 'font-semibold text-foreground'
                : 'text-muted-foreground',
            )}
          >
            {CLIENT_STAGE_LABELS[step]}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The engagement this client should see progress for, not every card. */
const pickPrimaryOpportunity = (results: Opportunity[]): Opportunity | undefined => {
  const documentWorkflow = results.filter((o) => o.pipeline.isDocumentPipeline);
  const pool = documentWorkflow.length > 0 ? documentWorkflow : results;
  // Most recently touched - if a firm somehow runs two engagements at once,
  // the one someone is actively working is more useful than the oldest.
  return [...pool].sort((a, b) => {
    const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bt - at;
  })[0];
};

export function EngagementProgress({ clientId }: { clientId: string }) {
  const { data, isPending, isError } = useMyDocuments(clientId);

  if (isPending) {
    return (
      <Card flat className="mb-6 p-4">
        <Skeleton className="mb-4 h-4 w-40" />
        <Skeleton className="h-16 w-full" />
      </Card>
    );
  }

  // Not an error state worth alarming over - a brand-new client simply has no
  // engagement yet, so there is nothing to chart.
  if (isError) return null;

  const opportunity = pickPrimaryOpportunity(data?.results ?? []);
  if (!opportunity?.stage) return null;

  return (
    <Card flat className="mb-6 p-4 sm:p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Your engagement status
          </h2>
          <p className="text-sm text-muted-foreground">{opportunity.name}</p>
        </div>
      </div>

      <Stepper stage={opportunity.stage.clientStage} />

      {data?.sync.degraded && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name="warning" className="h-3.5 w-3.5" />
          Showing the last known status - we couldn&apos;t reach the server
          just now.
        </p>
      )}
    </Card>
  );
}
