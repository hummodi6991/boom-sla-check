import { isUuid } from '../../shared/lib/uuid.js';
import { prisma } from '../../../lib/db.js';

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const appUrl = () => (process.env.APP_URL ?? 'https://app.boomnow.com').replace(/\/+$/,'');

async function probeRedirectForUuid(idOrSlug) {
  const base = appUrl();
  const url  = `${base}/r/conversation/${encodeURIComponent(String(idOrSlug))}`;
  // Some hosts disallow HEAD; try HEAD then GET with manual redirect.
  const tryOnce = async (method) => {
    const res = await fetch(url, { method, redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    const m = /conversation=([0-9a-f-]{36})/i.exec(loc);
    return m ? m[1].toLowerCase() : null;
  };
  try {
    return (await tryOnce('HEAD')) || (await tryOnce('GET'));
  } catch {
    return null;
  }
}

function firstUuid(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

function* textFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  const keys = ['text', 'body', 'html', 'content', 'message', 'snippet', 'subject'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') yield v;
  }
}

async function tryUuidFromInlineThread(inlineThread) {
  if (!inlineThread || typeof inlineThread !== 'object') return null;

  const direct =
    inlineThread.conversation_uuid ||
    inlineThread.conversationUuid ||
    inlineThread.uuid ||
    inlineThread.conversation?.uuid;
  const directHit = firstUuid(String(direct || ''));
  if (directHit) return directHit;

  const msgs =
    (Array.isArray(inlineThread.messages) && inlineThread.messages) ||
    (Array.isArray(inlineThread.thread) && inlineThread.thread) ||
    (Array.isArray(inlineThread.items) && inlineThread.items) || [];

  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const cands = [
      m.conversation_uuid, m.conversationUuid, m.thread_uuid, m.uuid,
      m.conversation?.uuid, m.thread?.uuid,
    ];
    for (const c of cands) {
      const hit = firstUuid(String(c || ''));
      if (hit) return hit;
    }
    for (const s of textFields(m)) {
      const q = s.match(/conversation=([0-9a-fA-F-]{36})/);
      if (q && UUID_RE.test(q[1])) return q[1].toLowerCase();
      const any = firstUuid(s);
      if (any) return any;
    }
  }

  // map numeric/slug ids found in messages via DB
  const idSet = new Set();
  for (const m of msgs) {
    const vals = [m?.conversation?.id, m?.conversation_id, m?.meta?.conversation_id, m?.headers?.conversation_id]
      .filter(v => v != null);
    for (const v of vals) idSet.add(String(v));
  }
  for (const v of idSet) {
    if (/^\d+$/.test(v)) {
      try {
        const row = await prisma?.conversation?.findFirst?.({ where: { legacyId: Number(v) }, select: { uuid: true }});
        if (row?.uuid && isUuid(row.uuid)) return row.uuid.toLowerCase();
      } catch {}
    }
    try {
      const bySlug = await prisma?.conversation?.findFirst?.({ where: { slug: v }, select: { uuid: true }});
      if (bySlug?.uuid && isUuid(bySlug.uuid)) return bySlug.uuid.toLowerCase();
    } catch {}
  }
  return null;
}

export async function tryResolveConversationUuid(idOrUuid, opts = {}) {
  const raw = String(idOrUuid ?? '').trim();
  const attempted = [];

  if (!raw) return null;

  attempted.push('direct-uuid');
  if (isUuid(raw)) return raw.toLowerCase();

  // DB paths
  try {
    const n = Number(raw);
    if (Number.isInteger(n)) {
      attempted.push('db-legacyId');
      const byNum = await prisma?.conversation?.findFirst?.({ where: { legacyId: n }, select: { uuid: true }});
      if (byNum?.uuid && isUuid(byNum.uuid)) return byNum.uuid.toLowerCase();
    }
    attempted.push('db-slug');
    const bySlug = await prisma?.conversation?.findFirst?.({ where: { slug: raw }, select: { uuid: true }});
    if (bySlug?.uuid && isUuid(bySlug.uuid)) return bySlug.uuid.toLowerCase();
  } catch {}

  // Inline thread mining
  attempted.push('inline-thread');
  const mined = await tryUuidFromInlineThread(opts.inlineThread);
  if (mined) return mined;

  // NEW: Redirect probe (public route resolves legacy id/slug → uuid)
  attempted.push('redirect-probe');
  const probed = await probeRedirectForUuid(raw);
  if (probed) return probed;

  // Optional: expose attempted paths for caller logging (if desired)
  opts.onDebug && opts.onDebug({ attempted });

  return null;
}
