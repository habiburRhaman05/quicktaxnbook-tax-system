'use client';

import { Icon } from '@/components/icons/app-icons';
import { DocumentUploadZone } from '@/components/client-portal/document-upload-zone';
import { EngagementProgress } from '@/components/client-portal/engagement-progress';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader, PageLayout } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useMyDocumentFiles,
  useMyRequests,
} from '@/features/documents/hooks/use-documents';
import {
  OPEN_REQUEST_STATUSES,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_STYLES,
  formatBytes,
  type DocumentRequestItem,
} from '@/features/documents/types';
import { cn } from '@/libs/utils';

/** One checklist item from the firm, with its own inline upload zone. */
function RequestRow({
  request,
  clientId,
}: {
  request: DocumentRequestItem;
  clientId: string;
}) {
  const open = OPEN_REQUEST_STATUSES.includes(request.status);

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{request.title}</span>
          {request.isRequired && (
            <span className="text-xs text-destructive">Required</span>
          )}
          <Badge
            variant="outline"
            className={cn('text-[11px]', REQUEST_STATUS_STYLES[request.status])}
          >
            {REQUEST_STATUS_LABELS[request.status]}
          </Badge>
        </div>
        {request.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {request.description}
          </p>
        )}
        {request.status === 'REJECTED' && request.rejectedReason && (
          <p className="mt-1 text-sm text-destructive">
            {request.rejectedReason}
          </p>
        )}
        {request.dueDate && open && (
          <p className="mt-1 text-xs text-muted-foreground">
            Due {new Date(request.dueDate).toLocaleDateString()}
          </p>
        )}
        {request.documents.length > 0 && (
          <ul className="mt-2 space-y-1">
            {request.documents.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Icon name="check" className="h-3.5 w-3.5 text-emerald-600" />
                {doc.currentVersion?.file.originalName ?? doc.title}
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <div className="w-full sm:w-64">
          <DocumentUploadZone
            clientId={clientId}
            requestId={request.id}
            compact
          />
        </div>
      )}
    </div>
  );
}

export function MyDocuments({ clientId }: { clientId: string }) {
  const requestsQuery = useMyRequests(clientId);
  const filesQuery = useMyDocumentFiles(clientId);

  const requests = requestsQuery.data ?? [];
  const files = filesQuery.data ?? [];
  const openCount = requests.filter((r) =>
    OPEN_REQUEST_STATUSES.includes(r.status),
  ).length;

  return (
    <PageLayout>
      <PageHeader
        title="My documents"
        subtitle={
          openCount > 0
            ? `Your firm is waiting on ${openCount} ${openCount === 1 ? 'document' : 'documents'}.`
            : 'Upload documents for your firm and track their progress.'
        }
      />

      {/* Overall progress first - this is what answers "what's going on with
          this work", before the client sees any per-file detail. */}
      <EngagementProgress clientId={clientId} />

      {/* Unprompted upload - the client never has to wait for a request. */}
      <Card flat className="mb-6 p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">
          Upload a document
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Have something to send? Upload it any time - you don&apos;t need to
          wait for your firm to ask.
        </p>
        <DocumentUploadZone clientId={clientId} />
      </Card>

      {/* Requested by the firm */}
      <h2 className="mb-2 text-sm font-semibold text-foreground">
        Requested by your firm
      </h2>
      <Card flat className="mb-6 overflow-hidden py-0">
        {requestsQuery.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : requestsQuery.isError ? (
          <EmptyState
            icon="warning"
            title="Unable to load requests"
            description="Something went wrong. Please refresh the page."
          />
        ) : requests.length === 0 ? (
          <EmptyState
            icon="checkCircle"
            title="Nothing requested"
            description="Your firm hasn't asked you for any documents right now."
          />
        ) : (
          <div>
            {requests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                clientId={clientId}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Everything uploaded */}
      <h2 className="mb-2 text-sm font-semibold text-foreground">
        Your uploads
      </h2>
      <Card flat className="overflow-hidden py-0">
        {filesQuery.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            icon="folder"
            title="No uploads yet"
            description="Documents you upload will be listed here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>For</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <TableRow key={file.id}>
                  <TableCell className="font-medium text-foreground">
                    {file.originalName ?? file.title}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {file.requestTitle ?? (
                      <span className="text-xs italic">Sent on your own</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatBytes(file.sizeBytes)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(file.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    {file.fileUrl && (
                      <a
                        href={file.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        View
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageLayout>
  );
}
