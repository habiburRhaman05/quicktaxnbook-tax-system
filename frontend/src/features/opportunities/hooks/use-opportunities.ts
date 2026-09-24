'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { apiFetch, ApiError } from '@/libs/api-client';
import type {
  Opportunity,
  OpportunityListResult,
  PipelineWithStages,
} from '@/features/opportunities/types';

const opportunitiesKey = (pipelineId?: string) =>
  ['opportunities', pipelineId ?? 'all'] as const;
const pipelinesKey = () => ['opportunities', 'pipelines'] as const;
const myDocsKey = (clientId?: string) => ['opportunities', 'mine', clientId ?? 'default'] as const;

/** Staff: every opportunity in the firm, synced from GoHighLevel on load. */
export function useOpportunities(pipelineId?: string) {
  return useQuery({
    queryKey: opportunitiesKey(pipelineId),
    queryFn: () =>
      apiFetch<OpportunityListResult>(
        `/opportunities${pipelineId ? `?pipelineId=${encodeURIComponent(pipelineId)}` : ''}`,
      ).then((r) => r.data),
  });
}

export function usePipelines() {
  return useQuery({
    queryKey: pipelinesKey(),
    queryFn: () =>
      apiFetch<{ results: PipelineWithStages[] }>(
        '/opportunities/pipelines',
      ).then((r) => r.data.results),
  });
}

/** Explicit Refresh button - forces a pull from GoHighLevel. */
export function useRefreshOpportunities() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ synced: boolean; error?: string }>('/opportunities/refresh', {
        method: 'POST',
      }),
    onSuccess: (result) => {
      toast.success(result.message);
      void queryClient.invalidateQueries({ queryKey: ['opportunities'] });
    },
    onError: (error: ApiError) => toast.error(error.message),
  });
}

interface MoveStageVars {
  opportunityId: string;
  stageId: string;
  pipelineId?: string;
}

/**
 * Drag-and-drop stage change.
 *
 * Optimistic: the card moves the instant it is dropped, because waiting on a
 * GoHighLevel round trip would make every drag feel broken. If the push fails
 * the previous board is restored and the error surfaced - the card visibly
 * snaps back rather than silently lying about a stage GHL never accepted.
 */
export function useMoveStage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ opportunityId, stageId }: MoveStageVars) =>
      apiFetch(`/opportunities/${opportunityId}/stage`, {
        method: 'PATCH',
        body: { stageId },
      }),

    onMutate: async ({ opportunityId, stageId, pipelineId }) => {
      const key = opportunitiesKey(pipelineId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<OpportunityListResult>(key);

      queryClient.setQueryData<OpportunityListResult>(key, (current) => {
        if (!current) return current;
        return {
          ...current,
          results: current.results.map((opp) =>
            opp.id !== opportunityId
              ? opp
              : {
                  ...opp,
                  // Stage details are re-resolved from the server response on
                  // settle; this only needs to be enough to re-bucket the card.
                  stage: opp.stage ? { ...opp.stage, id: stageId } : opp.stage,
                },
          ),
        };
      });

      return { previous, key };
    },

    onError: (error: ApiError, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.key, context.previous);
      }
      toast.error(error.message || 'Could not update the stage in GoHighLevel');
    },

    onSettled: () => {
      // Re-pull so the card reflects exactly what GoHighLevel stored, including
      // anything a workflow there changed as a side effect of the move.
      void queryClient.invalidateQueries({ queryKey: ['opportunities'] });
    },
  });
}

/**
 * Client portal: the signed-in client's own opportunities - this is what
 * drives the engagement progress bar ("where is my return at").
 *
 * `clientId` matters once a portal user has more than one entity (see
 * EntitySwitcher) - without it the backend defaults to their first access
 * grant, which would show the wrong engagement after switching entities.
 */
export function useMyDocuments(clientId?: string) {
  return useQuery({
    queryKey: myDocsKey(clientId),
    queryFn: () =>
      apiFetch<OpportunityListResult>(
        `/opportunities/mine/list${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`,
      ).then((r) => r.data),
  });
}

export type { Opportunity };
