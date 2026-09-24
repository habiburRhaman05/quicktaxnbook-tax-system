'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';

import { Icon } from '@/components/icons/app-icons';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import InputError from '@/components/ui/input-error';
import { Label } from '@/components/ui/label';
import { useConnectFirmGhl } from '@/features/firm/hooks/use-firm-ghl';
import {
  connectFirmGhlSchema,
  type ConnectFirmGhlInput,
} from '@/features/firm/schemas/connect-firm-ghl';
import type { GhlFirmLocationState } from '@/features/firm/types';

/** Why the agency pre-check could not reach a verdict. Mirrors the backend's
 * `GhlPrecheckReason`, but every branch is a human sentence instead of a code. */
const REASON_MESSAGES: Record<string, string> = {
  GHL_DISABLED: 'GoHighLevel is not enabled on this deployment.',
  AGENCY_TOKEN_MISSING: 'No GoHighLevel agency is connected yet.',
  AGENCY_TOKEN_REJECTED:
    'The agency token was rejected by GoHighLevel, so this sub-account could not be checked.',
  LOCATION_NOT_FOUND:
    'GoHighLevel has no sub-account with that id under this agency.',
  GHL_UNREACHABLE: 'Could not reach GoHighLevel to verify this sub-account.',
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/70 px-4 py-10">
      <Card className="w-full max-w-lg">{children}</Card>
    </div>
  );
}

function Notice({
  title,
  description,
  tone = 'warning',
}: {
  title: string;
  description: string;
  tone?: 'warning' | 'default';
}) {
  return (
    <Shell>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon
            name={tone === 'warning' ? 'warning' : 'shieldCheck'}
            className="h-4 w-4"
          />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Shell>
  );
}

/**
 * The `/firms/{locationId}` entry point, opened from a GoHighLevel custom menu
 * link.
 *
 * The sub-account id comes from the URL and is never trusted alone: the server
 * has already checked it against the connected agency before this renders. Only
 * a verified sub-account that is linked to a firm reaches the token step.
 */
export function GhlFirmConnectGate({
  locationId,
  initialState,
}: {
  locationId: string;
  initialState: GhlFirmLocationState | null;
}) {
  const router = useRouter();

  const form = useForm<ConnectFirmGhlInput>({
    resolver: zodResolver(connectFirmGhlSchema),
    defaultValues: { privateToken: '' },
  });
  const connect = useConnectFirmGhl(locationId, form);
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit((values) => {
    connect.mutate(values, {
      // The route handler set the session cookies; the firm layout reads them
      // and renders the dashboard for this firm.
      onSuccess: (result) =>
        router.replace(`/firm/${result.data.firm.slug}/dashboard`),
    });
  });

  if (!initialState) {
    return (
      <Notice
        title="Could not load this sub-account"
        description="The server did not return a usable response. Please reload the page or try again in a moment."
      />
    );
  }

  const { checked, exists, reason, location, firm } = initialState;

  // With no usable agency credential the agency check cannot run. That must not
  // block the firm: the token they paste is verified live against this exact
  // sub-account, which is the proof that matters.
  const agencyUnavailable =
    !checked &&
    (reason === 'AGENCY_TOKEN_MISSING' || reason === 'AGENCY_TOKEN_REJECTED');

  if (!checked && !agencyUnavailable) {
    return (
      <Notice
        title="Sub-account not verified"
        description={
          (reason && REASON_MESSAGES[reason]) ??
          'We could not verify this sub-account with GoHighLevel right now.'
        }
        tone={
          reason === 'GHL_UNREACHABLE' || reason === 'GHL_DISABLED'
            ? 'warning'
            : 'default'
        }
      />
    );
  }

  if (checked && !exists) {
    return (
      <Notice
        title="Not a valid sub-account"
        description="This GoHighLevel sub-account is not part of the connected agency, so it cannot be linked to a firm."
      />
    );
  }

  return (
    <Shell>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon name="shieldCheck" className="h-4 w-4" />
          Connect GoHighLevel
        </CardTitle>
        <CardDescription>
          Paste the Private Integration Token for{' '}
          <span className="font-medium text-foreground">
            {location?.name ?? locationId}
          </span>{' '}
          {firm
            ? `to open ${firm.name}'s dashboard.`
            : 'to open its dashboard - we set up the firm from this sub-account on first connect.'}{' '}
          It is verified with GoHighLevel before anything is saved.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="grid gap-4" onSubmit={onSubmit} noValidate>
          <div className="grid gap-2">
            <Label htmlFor="ghl-firm-token">Sub-account token *</Label>
            <Input
              id="ghl-firm-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the token"
              {...form.register('privateToken')}
            />
            <InputError message={errors.privateToken?.message} />
          </div>

          <Button type="submit" loading={connect.isPending}>
            <Icon name="link" className="h-4 w-4" /> Verify and open dashboard
          </Button>

          <p className="text-xs text-muted-foreground">
            Create the token in GoHighLevel for{' '}
            {location?.name ?? 'this sub-account'} under Settings → Private
            Integrations. It must belong to this sub-account.
          </p>
        </form>
      </CardContent>
    </Shell>
  );
}
