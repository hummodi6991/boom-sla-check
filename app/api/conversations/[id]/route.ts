import { NextResponse } from 'next/server';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  // Return safe defaults so the client UI never crashes while data is loading.
  return NextResponse.json({ id, related_reservations: [] });
}
