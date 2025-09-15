import { NextResponse } from 'next/server';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  // Always include safe defaults so client code can render without errors.
  return NextResponse.json({ id, related_reservations: [] });
}
