import { isUuid } from '../../shared/lib/uuid.js';
import { prisma } from '../../../lib/db.js';

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const appUrl = () => (process.env.APP_URL ?? 'https://app.boomnow.com').replace(/\/+$/,'');

function findUuidInString(s) {
  if (!s) return null;
  const m = String(s).match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

async function probeRedirectForUuid(idOrSlug) {
  const base = appUrl();
  const url  = `${base}/r/conversation/${encodeURIComponent(String(idOrSlug))}`;

  // 5s timeout
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);

  try {
    // 1) Prefer HEAD with manual redirect
    const head = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    let loc = head.headers.get('location') || '';
    let hit = (loc.match(/conversation=([0-9a-f-]{36})/i)?.[1] || '').toLowerCase();
    if (hit && UUID_RE.test(hit)) return hit;

    // 2) Fallback to GET with manual redirect
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    loc = res.headers.get('location') || '';
    hit = (loc.match(/conversation=([0-9a-f-]{36})/i)?.[1] || '').toLowerCase();
    if (hit && UUID_RE.test(hit)) return hit;

    // 3) If not a 3xx, parse the HTML body for meta-refresh or JS location.replace
    const body = await res.text().catch(() => '');
    // <meta http-equiv="refresh" content="0; url=...conversation=<uuid>">
    hit = (body.match(/conversation=([0-9a-f-]{36})/i)?.[1] || '').toLowerCase();
    if (hit && UUID_RE.test(hit)) return hit;

    // location.replace("...conversation=<uuid>")
    const js = body.match(/location\.replace\(["']([^"']+)["']\)/i)?.[1];
    const q = js ? new URLSearchParams(js.split('?')[1] || '') : null;
    const fromJs = q?.get('conversation');
    if (fromJs && UUID_RE.test(fromJs)) return fromJs.toLowerCase();

    // last resort: any raw UUID appearing in the body
    const raw = findUuidInString(body);
    if (raw) return raw;
  } catch {
    // ignore network/abort, fall through
  } finally {
    clearTimeout(t);
  }
  return null;
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
  const directHit = findUuidInString(String(direct || ''));
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
      const hit = findUuidInString(String(c || ''));
      if (hit) return hit;
    }
    for (const s of textFields(m)) {
      const q = s.match(/conversation=([0-9a-fA-F-]{36})/);
      if (q && UUID_RE.test(q[1])) return q[1].toLowerCase();
      const any = findUuidInString(s);
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

  // NEW: probe one message from API to read its conversation_uuid
  if (typeof opts.fetchFirstMessage === 'function') {
    attempted.push('messages-probe');
    try {
      const m = await opts.fetchFirstMessage(raw);
      const fromMsg =
        findUuidInString(m?.conversation_uuid) ||
        findUuidInString(m?.conversation?.uuid) ||
        findUuidInString(m?.body || m?.text || m?.html || m?.content);
      if (fromMsg) return fromMsg;
    } catch { /* ignore and continue */ }
  }

  // NEW: Redirect probe (public route resolves legacy id/slug → uuid)
  if (!opts.skipRedirectProbe) {
    attempted.push('redirect-probe');
    const probed = await probeRedirectForUuid(raw);
    if (probed) return probed;
  }

  // Optional: expose attempted paths for caller logging (if desired)
  opts.onDebug && opts.onDebug({ convId: raw, attempted });

  return null;
}
