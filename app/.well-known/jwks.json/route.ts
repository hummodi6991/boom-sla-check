import { NextResponse } from 'next/server.js';
import { currentLinkJwks } from '../../../src/lib/links/tokens';

export const runtime = 'nodejs';
export const revalidate = 0;

export async function GET() {
  const jwks = await currentLinkJwks();
  if (!jwks) {
    return NextResponse.json({ keys: [] }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(jwks, {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=60',
    },
  });
}
