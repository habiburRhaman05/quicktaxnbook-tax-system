'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Icon } from '@/components/icons/app-icons';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import InputError from '@/components/ui/input-error';
import { Label } from '@/components/ui/label';
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
  useClientDocuments,
  useClientRequests,
  useCreateDocumentRequest,
  useReviewRequest,
} from '@/features/documents/hooks/use-documents';
import {
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_STYLES,
  formatBytes,
} from '@/features/documents/types';
import { cn } from '@/libs/utils';

const requestFormSchema = z.object({
  title: z.string().min(1, 'Say what you need, e.g. "2024 W-2"'),
  description: z.string().optional(),
  dueDate: z.string().optional(),
});
type RequestFormInput = z.infer<typeof requestFormSchema>;

function RequestDocumentDialog({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const createRequest = useCreateDocumentRequest(clientId);

  const form = useForm<RequestFormInput>({
    resolver: zodResolver(requestFormSchema),
    defaultValues: { title: '', description: '', dueDate: '' },
  });

  const onSubmit = form.handleSubmit((values) => {
    createRequest.mutate(
      {
        clientId,
        title: values.title,
        description: values.description || undefined,
        dueDate: values.dueDate || undefined,
      },
      {
        onSuccess: () => {
          setOpen(false);
          form.reset();
        },
      },
    );
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) form.reset();
      }}
    >
      <Button onClick={() => setOpen(true)}>
        <Icon name="plus" className="h-4 w-4" /> Request document
      </Button>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Request a document</DialogTitle>
          <DialogDescription>
            The client sees this in their portal and can upload straight
            against it.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <div className="grid gap-2">
            <Label htmlFor="title">What do you need?</Label>
            <Input
              id="title"
              autoFocus
              placeholder="2024 W-2"
              {...form.register('title')}
            />
            <InputError message={form.formState.errors.title?.message} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Notes (optional)</Label>
            <Input
              id="description"
              placeholder="All pages, including the employer copy"
              {...form.register('description')}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dueDate">Due date (optional)</Label>
            <Input id="dueDate" type="date" {...form.register('dueDate')} />
          </div>
          <DialogFooter className="mt-2">
            <Button type="submit" loading={createRequest.isPending}>
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ClientDocumentsPanel({ clientId }: { clientId: string }) {
  const requestsQuery = useClientRequests(clientId);
  const filesQuery = useClientDocuments(clientId);
  const review = useReviewRequest(clientId);

  const requests = requestsQuery.data ?? [];
  const files = filesQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Document requests
          </h2>
          <p className="text-sm text-muted-foreground">
            Ask this client for what you need, then accept or reject what they
            send.
          </p>
        </div>
        <RequestDocumentDialog clientId={clientId} />
      </div>

      <Card flat className="overflow-hidden py-0">
        {requestsQuery.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            icon="folder"
            title="No requests yet"
            description="Request a document and it appears in the client's portal immediately."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">
                      {request.title}
                    </div>
                    {request.description && (
                      <div className="text-xs text-muted-foreground">
                        {request.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[11px]',
                        REQUEST_STATUS_STYLES[request.status],
                      )}
                    >
                      {REQUEST_STATUS_LABELS[request.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {request.documents.length === 0 ? (
                      '-'
                    ) : (
                      // A client may send several files against one request, so
                      // list them all rather than implying there was only one.
                      <ul className="space-y-0.5">
                        {request.documents.map((doc) => (
                          <li key={doc.id} className="text-xs">
                            {doc.currentVersion?.file.originalName ?? doc.title}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* Only actionable once the client has actually sent something. */}
                    {request.status === 'UPLOADED' && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          loading={review.isPending}
                          onClick={() =>
                            review.mutate({
                              requestId: request.id,
                              status: 'RECEIVED',
                            })
                          }
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={review.isPending}
                          onClick={() =>
                            review.mutate({
                              requestId: request.id,
                              status: 'REJECTED',
                              reason: 'Please re-upload a clearer copy.',
                            })
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-foreground">
          All uploads
        </h2>
        <Card flat className="overflow-hidden py-0">
          {filesQuery.isPending ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : files.length === 0 ? (
            <EmptyState
              icon="folder"
              title="Nothing uploaded yet"
              description="Files the client uploads appear here and in your GoHighLevel Media Library."
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
                        <span className="text-xs italic">Client-initiated</span>
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
      </div>
    </div>
  );
}
