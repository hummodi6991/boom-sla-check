import { NextResponse } from 'next/server.js';
import { appUrl } from '../../../../apps/shared/lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  // Always land on the CS page; the app/page handles UUID vs numeric.
  const to = `${appUrl()}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(params.id)}`;
  return NextResponse.redirect(to, 302);
}
