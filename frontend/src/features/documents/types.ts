export type DocumentRequestStatus =
  | 'REQUIRED'
  | 'MISSING'
  | 'UPLOADED'
  | 'RECEIVED'
  | 'REJECTED'
  | 'WAIVED';

export const REQUEST_STATUS_LABELS: Record<DocumentRequestStatus, string> = {
  REQUIRED: 'Requested',
  MISSING: 'Requested',
  UPLOADED: 'Uploaded - awaiting review',
  RECEIVED: 'Accepted',
  REJECTED: 'Needs another copy',
  WAIVED: 'No longer needed',
};

export const REQUEST_STATUS_STYLES: Record<DocumentRequestStatus, string> = {
  REQUIRED: 'bg-muted text-muted-foreground border-border',
  MISSING: 'bg-muted text-muted-foreground border-border',
  UPLOADED:
    'bg-blue-500/10 text-blue-700 border-blue-500/30 dark:text-blue-300',
  RECEIVED:
    'bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300',
  REJECTED:
    'bg-destructive/10 text-destructive border-destructive/30',
  WAIVED: 'bg-muted text-muted-foreground border-border',
};

/** Statuses where the client still has something to do. */
export const OPEN_REQUEST_STATUSES: DocumentRequestStatus[] = [
  'REQUIRED',
  'MISSING',
  'REJECTED',
];

export interface DocumentRequestItem {
  id: string;
  title: string;
  description: string | null;
  status: DocumentRequestStatus;
  isRequired: boolean;
  dueDate: string | null;
  createdAt: string;
  receivedAt: string | null;
  rejectedReason: string | null;
  clientId: string;
  documents: Array<{
    id: string;
    title: string;
    createdAt: string;
    currentVersion: {
      file: { key: string; originalName: string; sizeBytes: number };
    } | null;
  }>;
}

export interface ClientDocument {
  id: string;
  title: string;
  clientNote: string | null;
  requestId: string | null;
  requestTitle: string | null;
  requestStatus: DocumentRequestStatus | null;
  fileUrl: string | null;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export const ACCEPTED_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];

export const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.doc,.docx';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const formatBytes = (bytes: number | null): string => {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
