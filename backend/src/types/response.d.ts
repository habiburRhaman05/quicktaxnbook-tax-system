import { AccountRole } from '@prisma/client';

export interface TokenResponse {
  token: string;
  expires: Date;
}

export interface AuthTokensResponse {
  access: TokenResponse;
  refresh: TokenResponse;
}

/**
 * The authenticated actor attached to every request by `authenticate()`.
 * This is the single source of truth read by every RBAC check - never
 * inferred ad-hoc from relations.
 */
export interface AuthActor {
  userId: string;
  sessionId: string;
  accountRole: AccountRole;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Present for FIRM_ADMIN / FIRM_TEAM only. */
  firmId?: string;
  memberId?: string;
  isOwner?: boolean;
  /** Present for FIRM_CLIENT only. */
  clientIds?: string[];
}

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- required to extend passport's global User type
    interface User extends AuthActor {}
  }
}
