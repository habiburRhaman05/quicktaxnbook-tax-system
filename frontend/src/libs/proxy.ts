import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
} from '@/libs/auth-cookies';
import { backendFetch, bearer } from '@/libs/backend';
import { refreshTokens } from '@/libs/session';

interface ProxyOptions {
  method: string;
  path: string;
  body?: BodyInit | null;
  contentType?: string | null;
}

/**
 * Calls the Express API with the session's access token, transparently
 * refreshing once on a 401 and rotating the browser's cookies. Every
 * authenticated frontend request funnels through this - the generic
 * /api/backend/[...path] proxy and the handful of dedicated auth routes.
 */
export async function proxyToBackend({
  method,
  path,
  body,
  contentType,
}: ProxyOptions): Promise<NextResponse> {
  const cookieStore = await cookies();
  let accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;

  const baseHeaders: HeadersInit = contentType
    ? { 'content-type': contentType }
    : {};

  const attempt = (token?: string) =>
    backendFetch(path, {
      method,
      headers: { ...baseHeaders, ...bearer(token) },
      body: body ?? undefined,
    });

  let result = await attempt(accessToken);
  let rotated: Awaited<ReturnType<typeof refreshTokens>> = null;

  if (result.status === 401 && refreshToken) {
    rotated = await refreshTokens(refreshToken);
    if (rotated) {
      accessToken = rotated.access.token;
      result = await attempt(accessToken);
    }
  }

  const response = NextResponse.json(result.body, { status: result.status });
  if (rotated) {
    setAuthCookies(response.cookies, rotated);
  } else if (result.status === 401) {
    clearAuthCookies(response.cookies);
  }
  return response;
}
