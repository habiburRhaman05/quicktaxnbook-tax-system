/**
 * GoHighLevel (GHL) shared types.
 *
 * Shapes here mirror the official API v2 responses (verified against
 * https://marketplace.gohighlevel.com/docs). Only the fields we actually read
 * are typed; the index signature keeps the raw payload available without
 * pretending we model it completely.
 */

/**
 * Which credential a call is made with. This distinction matters because GHL
 * authorises per *token type*: some endpoints only accept an agency token,
 * others only a sub-account (location) token.
 */
export type GhlTokenKind = 'agency' | 'location';

export interface GhlToken {
  kind: GhlTokenKind;
  accessToken: string;
  /** Present for `location` tokens - also used as the concurrency bucket. */
  locationId?: string;
}

export type GhlHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface GhlRequestOptions {
  /** Path only, e.g. `/locations/abc123` - the base URL comes from config. */
  path: string;
  token: GhlToken;
  method?: GhlHttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * JSON request body. NOTE: never logged and never persisted as-is - GHL
   * payloads may carry PII.
   */
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /**
   * Bucket used for the per-location concurrency cap. Defaults to the token's
   * location, then to `agency`. Agency-token calls that target one location
   * should pass that location id so the cap still applies per firm.
   */
  concurrencyKey?: string;
}

export interface GhlResult<T> {
  status: number;
  data: T;
  requestId?: string;
  durationMs: number;
}

/** `GET /locations/:locationId` response. */
export interface GhlLocation {
  id: string;
  companyId?: string;
  name?: string;
  domain?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  timezone?: string;
  website?: string;
  business?: { name?: string };
  [key: string]: unknown;
}

export interface GhlLocationResponse {
  location: GhlLocation;
}

/** Trimmed, log-safe projection of a location. */
export interface GhlLocationSummary {
  locationId: string;
  name: string | null;
  companyId: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * A GoHighLevel contact, trimmed to what the client sync reads.
 *
 * `tags` is the important one: a contact is treated as a client only when it
 * carries the configured tag, never merely because it exists.
 */
export interface GhlContact {
  id: string;
  locationId?: string;
  firstName?: string | null;
  lastName?: string | null;
  contactName?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  tags?: string[];
  [key: string]: unknown;
}

/** A GoHighLevel user (staff member), trimmed to what the team sync reads. */
export interface GhlUser {
  id: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  roles?: { type?: string; role?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Why a pre-check could not reach a verdict. Each maps to a specific next step
 * in the Connect flow, so the UI never has to guess from an error string.
 */
export type GhlPrecheckReason =
  | 'GHL_DISABLED'
  | 'AGENCY_TOKEN_MISSING'
  | 'AGENCY_TOKEN_REJECTED'
  | 'LOCATION_NOT_FOUND'
  | 'GHL_UNREACHABLE';

export interface GhlLocationPrecheck {
  /** False whenever we cannot *prove* the location exists. */
  checked: boolean;
  exists: boolean;
  reason?: GhlPrecheckReason;
  location?: GhlLocationSummary;
  /** Set when this location is already linked to a firm in our database. */
  connectedFirmId?: string | null;
}
