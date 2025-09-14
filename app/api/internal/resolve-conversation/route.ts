import { NextResponse } from 'next/server.js';
import crypto from 'node:crypto';
import { prisma } from '../../../../lib/db';

const RESOLVE_SECRET = process.env.RESOLVE_SECRET || '';
const MAX_SKEW_MS = 2 * 60 * 1000; // 2 minutes

function hmac(data: string) {
  return crypto.createHmac('sha256', RESOLVE_SECRET).update(data).digest('hex');
}

export async function GET(req: Request) {
  if (!RESOLVE_SECRET) {
    return NextResponse.json({ error: 'disabled' }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const id = (searchParams.get('id') || '').trim();
  const ts = Number(searchParams.get('ts') || '0');
  const nonce = (searchParams.get('nonce') || '').trim();
  const sig = (searchParams.get('sig') || '').trim();

  if (!id || !ts || !nonce || !sig) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const now = Date.now();
  if (Math.abs(now - ts) > MAX_SKEW_MS) {
    return NextResponse.json({ error: 'stale' }, { status: 400 });
  }

  const payload = `id=${id}&ts=${ts}&nonce=${nonce}`;
  const expect = hmac(payload);
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Resolve by uuid, legacyId, or slug
  const n = Number(id);
  const uuidLike = /^[0-9a-f-]{36}$/i.test(id);
  let row = null;
  if (uuidLike) {
    row = await prisma.conversation.findFirst({ where: { uuid: id.toLowerCase() }, select: { uuid: true } });
  }
  if (!row && Number.isInteger(n)) {
    row = await prisma.conversation.findFirst({ where: { legacyId: n }, select: { uuid: true } });
  }
  if (!row) {
    row = await prisma.conversation.findFirst({ where: { slug: id }, select: { uuid: true } });
  }

  if (!row?.uuid) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json({ uuid: row.uuid.toLowerCase() }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
