import { NextRequest, NextResponse } from 'next/server';
import { signSession, verifySession, SESSION_COOKIE } from '@/lib/auth/passcode';

export const config = {
  // Keep an anonymous signed session for per-session generation rate limits.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (session) return NextResponse.next();

  const signed = await signSession();
  const res = NextResponse.next();
  res.cookies.set(SESSION_COOKIE, signed.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: signed.maxAge,
  });
  return res;
}
