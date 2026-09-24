'use client';

import { useRef, useState, type DragEvent } from 'react';

import { Icon } from '@/components/icons/app-icons';
import { Button } from '@/components/ui/button';
import { useUploadDocument } from '@/features/documents/hooks/use-documents';
import {
  ACCEPT_ATTR,
  ACCEPTED_MIME,
  MAX_UPLOAD_BYTES,
  formatBytes,
} from '@/features/documents/types';
import { cn } from '@/libs/utils';
import { toast } from 'sonner';

interface Props {
  clientId: string;
  /** Set when fulfilling a specific staff request. */
  requestId?: string;
  /** Compact variant used inline inside a request row. */
  compact?: boolean;
  onUploaded?: () => void;
}

export function DocumentUploadZone({
  clientId,
  requestId,
  compact = false,
  onUploaded,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // "file 2 of 5" - without this a multi-file drop looks stuck on one bar.
  const [queue, setQueue] = useState<{ done: number; total: number } | null>(null);
  const upload = useUploadDocument(clientId);

  /** Same rules the backend enforces - checked here only to fail fast. */
  const validate = (file: File): string | null => {
    if (file.size > MAX_UPLOAD_BYTES) {
      return `${file.name} is ${formatBytes(file.size)} - the limit is 10MB.`;
    }
    // Some browsers report an empty type for .doc/.docx, so fall back to the
    // extension rather than rejecting a file the server would accept.
    const extOk = /\.(pdf|jpe?g|png|docx?)$/i.test(file.name);
    if (!ACCEPTED_MIME.includes(file.type) && !extOk) {
      return `${file.name} isn't a supported type. Use PDF, JPG, PNG or DOCX.`;
    }
    return null;
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;

    const accepted: File[] = [];
    for (const file of Array.from(files)) {
      const problem = validate(file);
      if (problem) toast.error(problem);
      else accepted.push(file);
    }
    if (accepted.length === 0) {
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setQueue({ done: 0, total: accepted.length });
    for (const [index, file] of accepted.entries()) {
      setQueue({ done: index, total: accepted.length });
      setProgress(0);
      try {
        await upload.mutateAsync({
          clientId,
          requestId,
          file,
          onProgress: setProgress,
        });
        onUploaded?.();
      } catch {
        // useUploadDocument already surfaces the error as a toast.
      } finally {
        setProgress(null);
      }
    }
    setQueue(null);

    // Reset so selecting the same file twice still fires a change event.
    if (inputRef.current) inputRef.current.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
  };

  const busy = upload.isPending || progress !== null || queue !== null;

  return (
    <div className={compact ? '' : 'mb-6'}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !busy) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Upload a document"
        aria-busy={busy}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          compact ? 'gap-1 px-3 py-4' : 'gap-2 px-4 py-10',
          dragging
            ? 'border-primary bg-primary/5'
            : 'border-border bg-muted/30 hover:border-primary/40',
          busy && 'pointer-events-none opacity-70',
        )}
      >
        <Icon
          name="fileUpload"
          className={cn('text-muted-foreground', compact ? 'h-5 w-5' : 'h-8 w-8')}
        />
        {progress !== null ? (
          <div className="w-full max-w-xs">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1.5 text-center text-xs text-muted-foreground">
              {queue && queue.total > 1
                ? `Uploading ${queue.done + 1} of ${queue.total} - ${progress}%`
                : `Uploading… ${progress}%`}
            </p>
          </div>
        ) : (
          <>
            <p
              className={cn(
                'font-medium text-foreground',
                compact ? 'text-xs' : 'text-sm',
              )}
            >
              {compact
                ? 'Upload - you can add several files'
                : 'Drag files here, or click to browse'}
            </p>
            {!compact && (
              <p className="text-xs text-muted-foreground">
                PDF, JPG, PNG or DOCX - up to 10MB
              </p>
            )}
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {!compact && (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </Button>
        </div>
      )}
    </div>
  );
}
