import { NextResponse } from 'next/server.js';
import { prisma } from '../../../../lib/db';
import { appUrl, makeConversationLink } from '../../../../apps/shared/lib/links';
import { isUuid } from '../../../../apps/shared/lib/uuid';

async function resolveUuid(legacyIdStr: string) {
  const n = Number(legacyIdStr);
  if (!Number.isInteger(n)) return null;

  try {
    const alias = await prisma.conversation_aliases?.findUnique?.({ where: { legacy_id: n } });
    if (alias?.uuid && isUuid(alias.uuid)) return alias.uuid.toLowerCase();
  } catch {}

  const row = await prisma.conversation.findFirst({ where: { legacyId: n }, select: { uuid: true } });
  return row?.uuid && isUuid(row.uuid) ? row.uuid.toLowerCase() : null;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const base = appUrl();
  const uuid = await resolveUuid(params.id);

  const target = uuid
    ? makeConversationLink({ uuid }) ?? `${base}/conversation-not-found`
    : `${base}/conversation-not-found`;

  const html = `<!doctype html>
    <meta http-equiv="refresh" content="0; url=${target}">
    <script>try{location.replace(${JSON.stringify(target)})}catch(e){location.href=${JSON.stringify(target)}}<\/script>`;

  return new NextResponse(html, {
    status: 302,
    headers: {
      Location: target,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
