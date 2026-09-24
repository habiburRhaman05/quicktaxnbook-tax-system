import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import {
  ACCESS_COOKIE,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAuthCookies,
  type TokenPair,
} from '@/libs/auth-cookies';
import { backendFetch, bearer } from '@/libs/backend';
import { refreshTokens } from '@/libs/session';

// Overrides the generic /api/backend/[...path] proxy for this one endpoint:
// a successful password change revokes every existing session and returns a
// brand new token pair, so the browser's cookies must be replaced with THAT
// pair - not with whatever the generic proxy's own refresh logic would do.
export async function PATCH(req: Request) {
  const cookieStore = await cookies();
  let accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  const payload = await req.text();

  const attempt = (token?: string) =>
    backendFetch<{ tokens: TokenPair }>('/me/password', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...bearer(token) },
      body: payload,
    });

  let result = await attempt(accessToken);

  if (result.status === 401 && refreshToken) {
    const rotated = await refreshTokens(refreshToken);
    if (rotated) {
      accessToken = rotated.access.token;
      result = await attempt(accessToken);
    }
  }

  if (!result.body.success || !result.body.data) {
    const response = NextResponse.json(result.body, { status: result.status });
    if (result.status === 401) clearAuthCookies(response.cookies);
    return response;
  }

  const response = NextResponse.json(
    { ...result.body, data: {} },
    { status: result.status },
  );
  setAuthCookies(response.cookies, result.body.data.tokens);
  return response;
}
