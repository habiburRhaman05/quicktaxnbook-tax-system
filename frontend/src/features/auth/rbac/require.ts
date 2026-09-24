import { redirect } from 'next/navigation';

import { loginPathForRole, roleHomePath } from '@/features/auth/lib/role-home';
import { getCurrentUser } from '@/features/auth/server/get-current-user';
import type { AccountRole, CurrentUser } from '@/features/auth/types';

export async function requireUser(redirectTo = '/login'): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(redirectTo);
  return user;
}

/** Requires the user to hold one of `roles`. Wrong role -> /unauthorized. */
export async function requireRole(roles: AccountRole[]): Promise<CurrentUser> {
  const user = await requireUser(loginPathForRole(roles[0]));
  if (!roles.includes(user.accountRole)) redirect('/unauthorized');
  return user;
}

/** Requires the user to be FIRM_ADMIN/FIRM_TEAM AND belong to the firm
 * identified by `firmSlug` in the URL - never trust the URL param alone. */
export async function requireFirmMember(
  firmSlug: string,
): Promise<CurrentUser> {
  const user = await requireRole(['FIRM_ADMIN', 'FIRM_TEAM']);
  if (user.membership?.firm.slug !== firmSlug) {
    redirect(roleHomePath(user));
  }
  return user;
}

/** Requires the user to be FIRM_CLIENT AND have access to `clientId` in the
 * URL - and that entity must still be active (a firm can deactivate one
 * entity without the whole login being blocked, so this can't just be a
 * broader account-status check). */
export async function requireClientAccess(
  clientId: string,
): Promise<CurrentUser> {
  const user = await requireRole(['FIRM_CLIENT']);
  const access = user.clients?.find((entry) => entry.client.id === clientId);
  if (!access || access.client.status !== 'ACTIVE') {
    redirect(roleHomePath(user));
  }
  return user;
}
