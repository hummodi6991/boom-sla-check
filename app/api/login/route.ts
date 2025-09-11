import { NextResponse } from 'next/server.js';
import { createSessionCookie } from '../../../lib/auth';

export async function POST(req: Request) {
  const form = await req.formData();
  const email = String(form.get('email') || '');
  const password = String(form.get('password') || '');
  const next = String(form.get('next') || '/');

  if (!email || !password) {
    return NextResponse.json({ error: 'Missing credentials' }, { status: 400 });
  }

  // TODO: replace with real auth check
  const cookie = await createSessionCookie({ sub: email, email });

  const dest = next.startsWith('/') ? next : '/';
  const res = NextResponse.redirect(new URL(dest, req.url), { status: 303 });
  res.headers.append('Set-Cookie', cookie);
  return res;
}

