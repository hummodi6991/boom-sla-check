import { NextResponse } from 'next/server.js';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const url = new URL('/dashboard/guest-experience/cs', req.url);
  url.searchParams.set('conversation', params.id);
  return NextResponse.redirect(url, { status: 307 });
}
