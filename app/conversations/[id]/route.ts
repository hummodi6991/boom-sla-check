import { NextResponse } from 'next/server.js';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const base = new URL(req.url);
  const url = new URL(`/go/c/${encodeURIComponent(params.id)}`, base.origin);
  return NextResponse.redirect(url, { status: 307 });
}
