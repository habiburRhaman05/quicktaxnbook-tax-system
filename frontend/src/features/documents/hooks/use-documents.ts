'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useApiMutation } from '@/hooks/use-api-mutation';
import { apiFetch, ApiError } from '@/libs/api-client';
import type {
  ClientDocument,
  DocumentRequestItem,
} from '@/features/documents/types';

const requestsKey = (clientId?: string) =>
  ['documents', 'requests', clientId ?? 'me'] as const;
const documentsKey = (clientId?: string) =>
  ['documents', 'files', clientId ?? 'me'] as const;

/** Staff: one client's document checklist. */
export function useClientRequests(clientId: string) {
  return useQuery({
    queryKey: requestsKey(clientId),
    queryFn: () =>
      apiFetch<{ results: DocumentRequestItem[] }>(
        `/documents/requests/client/${clientId}`,
      ).then((r) => r.data.results),
    enabled: !!clientId,
  });
}

/** Staff: every document a client has uploaded. */
export function useClientDocuments(clientId: string) {
  return useQuery({
    queryKey: documentsKey(clientId),
    queryFn: () =>
      apiFetch<{ results: ClientDocument[] }>(
        `/documents/client/${clientId}`,
      ).then((r) => r.data.results),
    enabled: !!clientId,
  });
}

/** Client portal: what my firm has asked me for. */
export function useMyRequests(clientId?: string) {
  return useQuery({
    queryKey: requestsKey(clientId),
    queryFn: () =>
      apiFetch<{ results: DocumentRequestItem[] }>(
        `/documents/my/requests${clientId ? `?clientId=${clientId}` : ''}`,
      ).then((r) => r.data.results),
  });
}

/** Client portal: everything I've uploaded. */
export function useMyDocumentFiles(clientId?: string) {
  return useQuery({
    queryKey: documentsKey(clientId),
    queryFn: () =>
      apiFetch<{ results: ClientDocument[] }>(
        `/documents/my/documents${clientId ? `?clientId=${clientId}` : ''}`,
      ).then((r) => r.data.results),
  });
}

interface CreateRequestVars {
  clientId: string;
  title: string;
  description?: string;
  isRequired?: boolean;
  dueDate?: string;
}

export function useCreateDocumentRequest(clientId: string) {
  const queryClient = useQueryClient();
  return useApiMutation<DocumentRequestItem, CreateRequestVars>({
    mutationFn: (values) =>
      apiFetch('/documents/requests', { method: 'POST', body: values }),
    onSuccessData: () => {
      void queryClient.invalidateQueries({ queryKey: requestsKey(clientId) });
    },
  });
}

export function useReviewRequest(clientId: string) {
  const queryClient = useQueryClient();
  return useApiMutation<
    DocumentRequestItem,
    { requestId: string; status: 'RECEIVED' | 'REJECTED'; reason?: string }
  >({
    mutationFn: ({ requestId, ...body }) =>
      apiFetch(`/documents/requests/${requestId}/review`, {
        method: 'PATCH',
        body,
      }),
    onSuccessData: () => {
      void queryClient.invalidateQueries({ queryKey: requestsKey(clientId) });
      void queryClient.invalidateQueries({ queryKey: documentsKey(clientId) });
    },
  });
}

interface UploadVars {
  clientId: string;
  file: File;
  requestId?: string;
  title?: string;
  clientNote?: string;
  /** 0-100, reported as the bytes go out. */
  onProgress?: (percent: number) => void;
}

/**
 * File upload.
 *
 * Uses XMLHttpRequest rather than fetch because fetch still cannot report
 * upload progress in browsers - and a multi-megabyte upload with no progress
 * bar reads as a frozen page.
 */
function uploadWithProgress(vars: UploadVars): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', vars.file);
    form.append('clientId', vars.clientId);
    if (vars.requestId) form.append('requestId', vars.requestId);
    if (vars.title) form.append('title', vars.title);
    if (vars.clientNote) form.append('clientNote', vars.clientNote);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backend/documents/upload');
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        vars.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      let parsed: { success?: boolean; message?: string } | null = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && parsed?.success !== false) {
        resolve();
        return;
      }
      reject(
        new ApiError(
          parsed?.message ?? 'Upload failed. Please try again.',
          xhr.status,
        ),
      );
    };

    xhr.onerror = () =>
      reject(new ApiError('Could not reach the server.', 0));
    xhr.ontimeout = () =>
      reject(new ApiError('The upload timed out. Please try again.', 504));

    xhr.send(form);
  });
}

export function useUploadDocument(clientId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: UploadVars) => uploadWithProgress(vars),
    onSuccess: () => {
      toast.success('Document uploaded');
      void queryClient.invalidateQueries({ queryKey: requestsKey(clientId) });
      void queryClient.invalidateQueries({ queryKey: documentsKey(clientId) });
    },
    onError: (error: ApiError) => toast.error(error.message),
  });
}
