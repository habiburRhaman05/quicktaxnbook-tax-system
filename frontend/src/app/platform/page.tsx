import { redirect } from 'next/navigation';

import { AgencyEntryForm } from '@/components/platform/agency-entry-form';
import { getCurrentUser } from '@/features/auth/server/get-current-user';

interface PlatformEntryPageProps {
  searchParams: Promise<{
    relationshipNumber?: string;
    connect?: string;
    error?: string;
  }>;
}

/**
 * `/platform` - open to the agency admin, no password.
 *
 * - Already signed in as the platform owner: straight to the dashboard.
 * - `?relationshipNumber=...`: the saved token for that agency is verified with
 *   GoHighLevel and, if still good, the dashboard opens with no form at all.
 * - Otherwise (or when the saved token is no longer accepted): the form asks for
 *   the agency token and relationship number.
 */
export default async function PlatformEntryPage({
  searchParams,
}: PlatformEntryPageProps) {
  const { relationshipNumber, connect, error } = await searchParams;

  const user = await getCurrentUser();
  if (user?.accountRole === 'PLATFORM_OWNER') redirect('/platform/firms');

  if (relationshipNumber && !connect && !error) {
    redirect(
      `/api/platform/enter?relationshipNumber=${encodeURIComponent(relationshipNumber)}`,
    );
  }

  return <AgencyEntryForm relationshipNumber={relationshipNumber} error={error} />;
}
