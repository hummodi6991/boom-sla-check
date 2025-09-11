import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await getSession(req.headers);
  const dest = `/inbox/conversations/${params.id}`;
  const base = new URL(req.url);
  if (!session) {
    const url = new URL('/login', base.origin);
    url.searchParams.set('next', dest);
    return NextResponse.redirect(url, { status: 307 });
  }
  return NextResponse.redirect(new URL(dest, base), { status: 307 });
}

