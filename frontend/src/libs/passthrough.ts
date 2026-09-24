import 'server-only';

import { NextResponse } from 'next/server';

import type { TokenPair } from '@/libs/auth-cookies';
import { setAuthCookies } from '@/libs/auth-cookies';
import { backendFetch } from '@/libs/backend';

/** A plain POST passthrough to the Express API - no cookies involved. */
export function jsonPassthrough(path: string) {
  return async function handler(req: Request): Promise<NextResponse> {
    const payload = await req.text();
    const { status, body } = await backendFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    return NextResponse.json(body, { status });
  };
}

/** A login-shaped POST passthrough: on success, sets session cookies and
 * strips the raw tokens out of the JSON body sent to the browser. */
export function loginPassthrough(path: string) {
  return async function handler(req: Request): Promise<NextResponse> {
    const payload = await req.text();
    const { status, body } = await backendFetch<{
      user: unknown;
      tokens: TokenPair;
    }>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    if (!body.success || !body.data) {
      return NextResponse.json(body, { status });
    }

    const response = NextResponse.json(
      { ...body, data: { user: body.data.user } },
      { status },
    );
    setAuthCookies(response.cookies, body.data.tokens);
    return response;
  };
}
