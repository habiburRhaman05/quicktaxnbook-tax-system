export interface ApiFieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  statusCode: number;
  errors?: ApiFieldError[];

  constructor(message: string, statusCode: number, errors?: ApiFieldError[]) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data?: T;
  errors?: ApiFieldError[];
}

interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Set when sending a native FormData body (file uploads) - skips JSON.stringify/content-type. */
  isFormData?: boolean;
}

// Without this, a stalled proxy/backend request leaves this fetch pending
// forever, which leaves the caller's loading state stuck forever with no
// error ever surfacing to the user.
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(
  basePath: string,
  path: string,
  { method = 'GET', body, isFormData = false }: ApiFetchOptions,
): Promise<{ message: string; data: T }> {
  let res: Response;
  try {
    res = await fetch(`${basePath}${path}`, {
      method,
      credentials: 'same-origin',
      headers:
        isFormData || body === undefined
          ? undefined
          : { 'content-type': 'application/json' },
      body:
        body === undefined
          ? undefined
          : isFormData
            ? (body as FormData)
            : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError('The request timed out. Please try again.', 504);
    }
    throw new ApiError(
      'Could not reach the server. Please check your connection.',
      0,
    );
  }

  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;

  if (!json || !json.success) {
    throw new ApiError(
      json?.message ?? 'Something went wrong. Please try again.',
      json?.statusCode ?? res.status,
      json?.errors,
    );
  }

  return { message: json.message, data: json.data as T };
}

/**
 * Client-side fetch for authenticated app data. Always hits our own
 * same-origin /api/backend/<path> proxy (never the Express API directly) so
 * the session cookie is sent automatically and tokens never touch the page.
 */
export function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
) {
  return request<T>('/api/backend', path, { method: 'GET', ...options });
}

/** Same shape, for the dedicated /api/auth/* routes (login, logout, me, ...). */
export function authFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
) {
  return request<T>('/api/auth', path, { method: 'POST', ...options });
}

/** Public, unauthenticated calls for the client onboarding flow. */
export function onboardingFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
) {
  return request<T>('/api/onboarding', path, { method: 'GET', ...options });
}

/**
 * The agency admin's `/platform` entry (agency token + company id). Unauthenticated
 * on entry; its route handler owns the session cookies it sets on success.
 */
export function platformEntryFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
) {
  return request<T>('/api/platform', path, { method: 'POST', ...options });
}

/**
 * The firm GoHighLevel connect flow, opened from a GoHighLevel custom menu link
 * (`/firms/{locationId}`). Unauthenticated on entry - the sub-account Private
 * Integration Token is the credential, and its route handler owns the session
 * cookies it sets on success.
 */
export function firmFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
) {
  return request<T>('/api/firms', path, { method: 'GET', ...options });
}
