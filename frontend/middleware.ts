import { NextResponse, type NextRequest } from 'next/server';

import { ACCESS_COOKIE } from '@/libs/auth-cookies';
import { publicUrl } from '@/libs/public-url';

// Fast, cookie-presence-only redirect for obviously-unauthenticated visits.
// Real authorization (role checks, token validity) happens server-side in
// each area's layout.tsx via requireRole() - this is a UX shortcut only.
//
// `/platform` itself is deliberately NOT protected: it is the public entry where
// the agency admin enters the agency token + relationship number. Everything
// under it (`/platform/firms`, ...) needs a session and falls back to that entry.
// `/firms/...` (link entry for firm owners and team) is outside every matcher.
const CLIENT_PREFIXES = ['/client'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(ACCESS_COOKIE);

  if (hasSession) return NextResponse.next();

  if (pathname.startsWith('/platform/')) {
    return NextResponse.redirect(publicUrl(request, '/platform'));
  }
  if (pathname === '/firm' || pathname.startsWith('/firm/')) {
    return NextResponse.redirect(publicUrl(request, '/login'));
  }
  if (
    CLIENT_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return NextResponse.redirect(publicUrl(request, '/client-login'));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/platform/:path*', '/firm/:path*', '/client/:path*'],
};
