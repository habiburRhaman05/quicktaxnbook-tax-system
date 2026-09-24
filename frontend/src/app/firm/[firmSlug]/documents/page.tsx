import { DocumentsWorkspace } from '@/components/firm/documents-workspace';
import { requireFirmMember } from '@/features/auth/rbac/require';

export default async function FirmDocumentsPage({
  params,
}: {
  params: Promise<{ firmSlug: string }>;
}) {
  const { firmSlug } = await params;
  // Staff-only, and only for the firm named in the URL - never trust the slug alone.
  await requireFirmMember(firmSlug);
  return <DocumentsWorkspace />;
}
