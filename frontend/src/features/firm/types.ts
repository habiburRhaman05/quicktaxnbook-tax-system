import type { GhlLocationSummary } from '@/features/platform/types';

export type { GhlLocationSummary };

/** The firm a sub-account is linked to (safe projection - no credential). */
export interface GhlLinkedFirm {
  id: string;
  name: string;
  slug: string;
}

/**
 * Answer to "what should `/firms/{locationId}` show?".
 *
 * `exists` is only meaningful when `checked` is true - without an agency token
 * or when GoHighLevel is unreachable we report `checked: false` with a `reason`
 * rather than pretending the sub-account is invalid.
 */
export interface GhlFirmLocationState {
  checked: boolean;
  exists: boolean;
  reason?: string;
  location: GhlLocationSummary | null;
  firm: GhlLinkedFirm | null;
  connected: boolean;
}

export interface GhlFirmConnectResult {
  firm: GhlLinkedFirm;
  location: GhlLocationSummary | null;
}
