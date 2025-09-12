import { NextResponse } from 'next/server';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  // Deliberately omit related_reservations to exercise safe defaults
  return NextResponse.json({ id });
}
