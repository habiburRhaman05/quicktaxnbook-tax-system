import type { CurrentUser } from '@/features/auth/types';

/** Where a logged-in user's "home" is - the target of bare /firm, /client,
 * /platform, and / redirects, and of the auth pages once already signed in. */
export function roleHomePath(user: CurrentUser): string {
  switch (user.accountRole) {
    case 'PLATFORM_OWNER':
      return '/platform/firms';
    case 'FIRM_ADMIN':
    case 'FIRM_TEAM':
      return user.membership
        ? `/firm/${user.membership.firm.slug}/dashboard`
        : '/login';
    case 'FIRM_CLIENT': {
      const entity =
        user.clients?.find((access) => access.client.status === 'ACTIVE') ??
        user.clients?.[0];
      return entity ? `/client/${entity.client.id}/dashboard` : '/client-login';
    }
    default:
      return '/login';
  }
}

/** Which login page a role uses. */
export function loginPathForRole(
  role: CurrentUser['accountRole'] | undefined,
): string {
  return role === 'FIRM_CLIENT' ? '/client-login' : '/login';
}
