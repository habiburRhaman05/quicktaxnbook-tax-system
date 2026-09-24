'use client';

import { Icon } from '@/components/icons/app-icons';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  useConnectGhlAgency,
  useGhlAgency,
  useGhlAgencyLocations,
} from '@/features/platform/hooks/use-ghl-agency';
import {
  connectAgencySchema,
  type ConnectAgencyInput,
} from '@/features/platform/schemas/connect-agency';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

/**
 * Sub-accounts under the connected agency.
 *
 * Read-only against GoHighLevel - this only ever calls `GET /locations/search`.
 * Each row is a candidate target for a firm to connect to later.
 */
function SubAccountList({
  page,
  onPageChange,
}: {
  page: number;
  onPageChange: (page: number) => void;
}) {
  const { data, isPending } = useGhlAgencyLocations(page, true);
  const locations = data?.locations ?? [];

  if (isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (locations.length === 0) {
    return (
      <EmptyState
        icon="buildings"
        title="No sub-accounts found"
        description="This agency has no sub-accounts yet, or the token cannot read locations."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sub-account</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Location ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.map((location) => (
              <TableRow key={location.locationId}>
                <TableCell className="font-medium text-foreground">
                  {location.name ?? 'Unnamed'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <div>{location.email ?? 'N/A'}</div>
                  {location.phone ? (
                    <div className="text-xs">{location.phone}</div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-muted-foreground">
                    {location.locationId}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Page {data?.page ?? page}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <Icon name="left" className="h-4 w-4" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data?.hasMore}
            onClick={() => onPageChange(page + 1)}
          >
            Next <Icon name="right" className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Agency connect panel.
 *
 * The token is verified by GoHighLevel server-side before anything is stored, so
 * a typo can never leave a broken credential on file. The token is never
 * returned by the API, so it cannot be displayed back here.
 */
export function GhlAgencyCard() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [page, setPage] = useState(1);
  const { data: connection, isPending } = useGhlAgency();

  const form = useForm<ConnectAgencyInput>({
    resolver: zodResolver(connectAgencySchema),
    defaultValues: { privateToken: '', relationshipNumber: '' },
  });
  const connect = useConnectGhlAgency(form);
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit((values) => {
    connect.mutate(values, {
      onSuccess: () => {
        setDialogOpen(false);
        setPage(1);
        form.reset();
      },
    });
  });

  const isConnected = Boolean(connection);

  return (
    <Card flat>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="link" className="h-4 w-4" />
          GoHighLevel
          {!isPending ? (
            <Badge variant={isConnected ? 'successOutline' : 'warningOutline'}>
              {isConnected ? 'Connected' : 'Not connected'}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {isConnected
            ? 'Sub-accounts under this agency. Each firm connects to one of these.'
            : 'Connect the agency to list its sub-accounts. Paste the agency Private Integration Token - it is verified with GoHighLevel before being saved.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : connection ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailRow label="Agency">
                {connection.companyName ?? 'GoHighLevel agency'}
              </DetailRow>
              <DetailRow label="Company ID">
                <span className="font-mono text-xs">
                  {connection.companyId ?? 'Not detected'}
                </span>
              </DetailRow>
              <DetailRow label="Relationship number">
                {connection.relationshipNumber ?? 'Not set'}
              </DetailRow>
              <DetailRow label="Last verified">
                {connection.lastVerifiedAt
                  ? new Date(connection.lastVerifiedAt).toLocaleString()
                  : 'Never'}
              </DetailRow>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialogOpen(true)}
              >
                <Icon name="key" className="h-4 w-4" /> Replace token
              </Button>
            </div>

            <SubAccountList page={page} onPageChange={setPage} />
          </>
        ) : (
          <Button onClick={() => setDialogOpen(true)}>
            <Icon name="link" className="h-4 w-4" /> Connect GoHighLevel agency
          </Button>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <form onSubmit={onSubmit} noValidate>
            <DialogHeader>
              <DialogTitle>Connect GoHighLevel agency</DialogTitle>
              <DialogDescription>
                Paste the agency Private Integration Token. We call GoHighLevel
                to check it works, then store it encrypted - nothing is saved if
                the check fails.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="ghl-privateToken">
                  Agency Private Integration Token *
                </Label>
                <Input
                  id="ghl-privateToken"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the token"
                  {...form.register('privateToken')}
                />
                <InputError message={errors.privateToken?.message} />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="ghl-relationshipNumber">
                  Relationship number *
                </Label>
                <Input
                  id="ghl-relationshipNumber"
                  autoComplete="off"
                  placeholder="r0-933-305"
                  {...form.register('relationshipNumber')}
                />
                <InputError message={errors.relationshipNumber?.message} />
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={connect.isPending}>
                Connect agency
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
