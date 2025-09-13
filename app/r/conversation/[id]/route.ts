export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { prisma } from '../../../../lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]!));

async function toUuid(id: string) {
  if (UUID_RE.test(id)) return id;

  // legacy numeric id (keep only if your schema has it)
  if (!Number.isNaN(Number(id))) {
    const hit = await prisma.conversation
      .findFirst({
        where: { legacyId: Number(id) },
        select: { uuid: true },
      })
      .catch(() => null);
    if (hit?.uuid) return hit.uuid;
  }

  // slug/external/public id (keep only existing fields)
  const alt = await prisma.conversation
    .findFirst({
      where: { OR: [{ externalId: id }, { publicId: id }, { slug: id }] } as any,
      select: { uuid: true },
    })
    .catch(() => null);

  return alt?.uuid;
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  const uuid = await toUuid(params.id);
  const to = new URL('/dashboard/guest-experience/all', origin);
  if (uuid) to.searchParams.set('conversation', uuid);

  const href = to.toString();
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=${esc(href)}">
<title>Opening conversation…</title>
<p>If you are not redirected, <a href="${esc(href)}" rel="nofollow">tap here to open the conversation</a>.</p>
<script>try{location.replace(${JSON.stringify(href)})}catch(_) {location.href=${JSON.stringify(href)}};</script>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'cdn-cache-control': 'no-store',
      'vercel-cdn-cache-control': 'no-store',
    },
  });
}
