import { NextResponse } from 'next/server.js';
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return NextResponse.redirect(new URL(`/inbox/conversations/${params.id}`, req.url), { status: 307 });
}
