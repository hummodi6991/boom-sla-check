import { NextResponse } from 'next/server.js';

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const dest = new URL(`/inbox/conversations/${params.id}`, req.url);
  return NextResponse.redirect(dest, { status: 307 });
}

