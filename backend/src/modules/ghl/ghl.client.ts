import config from '@/config/config';
import logger from '@/config/logger';

import type { GhlRequestOptions, GhlResult } from './ghl.types';

/** Transient failures worth retrying: rate limits and edge/upstream hiccups. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8_000;

/**
 * GHL rate-limits to ~100 requests / 10s per app + location. We stay well under
 * that, but the more important guard is concurrency: without it a burst of
 * dashboard calls for one firm can drain the budget for every other request to
 * that same location and start bouncing 429s.
 */
const MAX_CONCURRENT_PER_LOCATION = 5;

/**
 * GoHighLevel sits behind Cloudflare, which can reject requests that arrive with
 * no User-Agent. The runtime does not always send one, so set it explicitly
 * rather than discovering a 403 in production.
 */
const USER_AGENT = `${config.appName.replace(/\s+/g, '-')}/1.0`;

const inFlight = new Map<string, number>();
const waiters = new Map<string, Array<() => void>>();

/**
 * Thrown for any non-2xx GHL response, and for local guard failures (feature
 * disabled, no credential). `status` carries the upstream HTTP status so
 * callers can tell "this token is wrong" (401/403) apart from "GHL is having a
 * bad day" (5xx) without pattern-matching on messages.
 */
export class GhlApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly requestId?: string;

  constructor(message: string, status: number, body?: unknown, requestId?: string) {
    super(message);
    this.name = 'GhlApiError';
    this.status = status;
    this.body = body;
    this.requestId = requestId;
    if (Error.captureStackTrace) Error.captureStackTrace(this, GhlApiError);
  }

  /** True when retrying later could plausibly succeed (includes network errors). */
  get retryable(): boolean {
    return this.status === 0 || RETRYABLE_STATUS.has(this.status);
  }

  /** True when GHL rejected the credential rather than the request. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const acquireSlot = async (key: string): Promise<void> => {
  const current = inFlight.get(key) ?? 0;
  if (current < MAX_CONCURRENT_PER_LOCATION) {
    inFlight.set(key, current + 1);
    return;
  }
  await new Promise<void>((resolve) => {
    const queue = waiters.get(key) ?? [];
    queue.push(resolve);
    waiters.set(key, queue);
  });
};

const releaseSlot = (key: string): void => {
  const queue = waiters.get(key);
  if (queue && queue.length > 0) {
    // Hand the slot straight to the next waiter so the in-flight count stays put.
    const next = queue.shift();
    if (queue.length === 0) waiters.delete(key);
    next?.();
    return;
  }
  const current = inFlight.get(key) ?? 1;
  if (current <= 1) inFlight.delete(key);
  else inFlight.set(key, current - 1);
};

const buildUrl = (path: string, query?: GhlRequestOptions['query']): string => {
  const base = `${config.ghl.apiBaseUrl.replace(/\/+$/, '')}/`;
  const url = new URL(path.replace(/^\/+/, ''), base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
};

const backoffMs = (attempt: number, retryAfterHeader?: string | null): number => {
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.min(Math.max(retryAfterSeconds, 0) * 1000, MAX_BACKOFF_MS);
  }
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Jitter so parallel retries don't re-arrive in lockstep.
  return exponential + Math.floor(Math.random() * 100);
};

const parseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** GHL reports errors as `{ message }` in most places and `{ error }` in others. */
const extractErrorMessage = (data: unknown, status: number): string => {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['message', 'error'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return `GoHighLevel request failed with status ${status}`;
};

/**
 * The single entry point for every GoHighLevel HTTP call - nothing else in the
 * codebase may call GHL directly.
 *
 * The rules are baked in here so callers cannot forget them:
 *  - the `Version` header GHL requires is always sent;
 *  - every attempt has a timeout;
 *  - 429/5xx and network errors retry with exponential backoff (honouring
 *    `Retry-After`), with jitter;
 *  - concurrency is capped per location;
 *  - the access token and the request body are NEVER logged - bodies can carry
 *    PII, and tokens must not reach logs, metrics or error reporters.
 */
export const ghlRequest = async <T = unknown>(
  options: GhlRequestOptions
): Promise<GhlResult<T>> => {
  const {
    path,
    token,
    method = 'GET',
    query,
    body,
    timeoutMs = config.ghl.timeoutMs,
    retries = config.ghl.maxRetries,
    concurrencyKey = token.locationId ?? 'agency',
  } = options;

  if (!config.ghl.enabled) {
    throw new GhlApiError('GoHighLevel is disabled - set GHL_ENABLED=true to make live calls', 503);
  }
  if (!token.accessToken) {
    throw new GhlApiError(`Missing GoHighLevel ${token.kind} token`, 401);
  }

  const url = buildUrl(path, query);
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let failure: GhlApiError | null = null;
    let retryDelay: number | null = null;

    // Hold a concurrency slot only for the request itself, never for the backoff
    // wait below - otherwise a sleeping retry would block other callers.
    await acquireSlot(concurrencyKey);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Version: config.ghl.apiVersion,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const requestId = response.headers.get('x-request-id') ?? undefined;

      if (response.ok) {
        const data = (await parseBody(response)) as T;
        logger.debug(`GHL ${method} ${path} -> ${response.status} in ${Date.now() - startedAt}ms`);
        return {
          status: response.status,
          data,
          requestId,
          durationMs: Date.now() - startedAt,
        };
      }

      failure = new GhlApiError(
        extractErrorMessage(await parseBody(response), response.status),
        response.status,
        undefined,
        requestId
      );
      if (RETRYABLE_STATUS.has(response.status)) {
        retryDelay = backoffMs(attempt, response.headers.get('retry-after'));
      }
    } catch (error) {
      const isTimeout =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      failure = new GhlApiError(
        isTimeout
          ? `GoHighLevel request timed out after ${timeoutMs}ms`
          : 'Could not reach GoHighLevel',
        0
      );
      // Keep the transport-level cause for debugging. It never contains the
      // token or body, so this is safe to surface internally.
      if (error instanceof Error) failure.cause = error;
      retryDelay = backoffMs(attempt);
    } finally {
      releaseSlot(concurrencyKey);
    }

    const isLastAttempt = attempt === retries;
    if (retryDelay === null || isLastAttempt) {
      logger.warn(
        `GHL ${method} ${path} failed: ${failure.message} (status ${failure.status}, attempt ${
          attempt + 1
        }/${retries + 1})`
      );
      throw failure;
    }

    logger.warn(
      `GHL ${method} ${path} -> ${failure.status}; retrying in ${retryDelay}ms (attempt ${
        attempt + 1
      }/${retries + 1})`
    );
    await sleep(retryDelay);
  }

  /* istanbul ignore next -- the loop above always returns or throws. */
  throw new GhlApiError('GoHighLevel request failed', 0);
};
