import { NextResponse } from 'next/server';

import { setAuthCookies, type TokenPair } from '@/libs/auth-cookies';
import { backendFetch } from '@/libs/backend';

interface ConnectFirmPayload {
  firm: unknown;
  location: unknown;
  tokens: TokenPair;
}

/**
 * The firm sub-account connect step.
 *
 * Forwards the pasted token to Express, which verifies it with GoHighLevel and
 * links it to the firm before returning. The session tokens it hands back are
 * stripped out of the JSON and set as httpOnly cookies instead, so client
 * JavaScript can never read them - matching the agency connect route.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const payload = await req.text();

  const { status, body } = await backendFetch<ConnectFirmPayload>(
    '/ghl/firm/connect',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    },
  );

  if (!body.success || !body.data) {
    return NextResponse.json(body, { status });
  }

  const { tokens, ...data } = body.data;

  const response = NextResponse.json({ ...body, data }, { status });
  setAuthCookies(response.cookies, tokens);
  return response;
}
