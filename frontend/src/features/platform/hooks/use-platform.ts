'use client';

import { useApiMutation } from '@/hooks/use-api-mutation';
import { apiFetch } from '@/libs/api-client';
import type { PaginatedResult } from '@/libs/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseFormReturn } from 'react-hook-form';

import type { OnboardFirmInput } from '@/features/platform/schemas/onboard-firm';
import type { FirmRecord, FirmStatus } from '@/features/platform/types';

const firmsKey = () => ['platform', 'firms'] as const;
const firmKey = (firmId: string) => ['platform', 'firms', firmId] as const;

/** Empty-string optional fields must become undefined before hitting the
 * backend's zod schema - `.optional()` only skips validation for `undefined`,
 * not `''`. */
function blankToUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const key of Object.keys(out)) {
    const value = out[key as keyof T];
    if (value === '') {
      out[key as keyof T] = undefined as T[keyof T];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key as keyof T] = blankToUndefined(
        value as Record<string, unknown>,
      ) as T[keyof T];
    }
  }
  return out;
}

interface OnboardFirmResult {
  firm: FirmRecord;
  admin: { id: string; email: string; firstName: string; lastName: string };
  temporaryPassword: string;
}

export function useOnboardFirm(form?: UseFormReturn<OnboardFirmInput>) {
  const queryClient = useQueryClient();
  return useApiMutation<OnboardFirmResult, OnboardFirmInput, OnboardFirmInput>({
    mutationFn: (values) =>
      apiFetch('/platform/firms', {
        method: 'POST',
        body: blankToUndefined(values),
      }),
    form,
    onSuccessData: () => {
      void queryClient.invalidateQueries({ queryKey: firmsKey() });
    },
  });
}

export function useFirms() {
  return useQuery({
    queryKey: firmsKey(),
    queryFn: () =>
      apiFetch<PaginatedResult<FirmRecord>>('/platform/firms').then(
        (r) => r.data,
      ),
  });
}

export function useFirm(firmId: string) {
  return useQuery({
    queryKey: firmKey(firmId),
    queryFn: () =>
      apiFetch<FirmRecord>(`/platform/firms/${firmId}`).then((r) => r.data),
    enabled: !!firmId,
  });
}

export function useUpdateFirmStatus(firmId: string) {
  const queryClient = useQueryClient();
  return useApiMutation<FirmRecord, { status: FirmStatus }>({
    mutationFn: ({ status }) =>
      apiFetch(`/platform/firms/${firmId}/status`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccessData: () => {
      void queryClient.invalidateQueries({ queryKey: firmKey(firmId) });
      void queryClient.invalidateQueries({ queryKey: firmsKey() });
    },
  });
}
