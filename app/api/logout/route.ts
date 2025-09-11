import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth';

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL('/', req.url), { status: 303 });
  res.headers.append('Set-Cookie', clearSessionCookie());
  return res;
}

