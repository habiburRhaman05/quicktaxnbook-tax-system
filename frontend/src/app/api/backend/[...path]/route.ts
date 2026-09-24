import type { NextRequest } from 'next/server';

import { proxyToBackend } from '@/libs/proxy';

/**
 * Generic authenticated proxy: every team/client/platform/profile request
 * from the UI goes through here as /api/backend/<express-path>. Handles
 * token refresh transparently - see libs/proxy.ts.
 */
async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const target = `/${path.join('/')}`;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await req.arrayBuffer() : undefined;

  return proxyToBackend({
    method: req.method,
    path: `${target}${req.nextUrl.search}`,
    body,
    contentType: req.headers.get('content-type'),
  });
}

export {
  handle as DELETE,
  handle as GET,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
