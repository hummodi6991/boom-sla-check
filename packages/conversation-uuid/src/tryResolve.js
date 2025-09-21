import { isUuid } from './utils.js';
import { prisma } from '../../../lib/db.js';

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const appUrl = () => (process.env.APP_URL ?? 'https://app.boomnow.com').replace(/\/+$/,'');

const normalizeUuid = (value) => (typeof value === 'string' && isUuid(value) ? value.toLowerCase() : null);

function normalizeSlugCandidate(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function findUuidInString(s) {
  if (!s) return null;
  const m = String(s).match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

function extractUuidFromUniversalPath(value) {
  if (!value) return null;
  const match = String(value).match(/\/go\/c\/([^/?#]+)/i);
  if (!match?.[1]) return null;
  let token = match[1];
  try {
    token = decodeURIComponent(token);
  } catch {
    // ignore decode failures and use raw token
  }
  return UUID_RE.test(token) ? token.toLowerCase() : null;
}

function extractUuidFromCandidate(rawValue, baseUrl) {
  if (rawValue == null) return null;
  let value = String(rawValue).trim();
  if (!value) return null;

  // Strip wrapping quotes often present in meta refresh content attributes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  const directUniversal = extractUuidFromUniversalPath(value);
  if (directUniversal) return directUniversal;

  const queryMatch = value.match(/conversation=([0-9a-f-]{36})/i);
  if (queryMatch?.[1] && UUID_RE.test(queryMatch[1])) {
    return queryMatch[1].toLowerCase();
  }

  try {
    const parsed = new URL(value, baseUrl);
    const fromPath = extractUuidFromUniversalPath(parsed.pathname);
    if (fromPath) return fromPath;
    const fromQuery = parsed.searchParams.get('conversation');
    if (fromQuery && UUID_RE.test(fromQuery)) {
      return fromQuery.toLowerCase();
    }
  } catch {
    // ignore URL parse failures
  }

  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) {
      return extractUuidFromCandidate(decoded, baseUrl);
    }
  } catch {
    // ignore decode failures
  }

  return null;
}

async function findUuidByAliasLegacyId(legacyId) {
  if (!Number.isInteger(legacyId)) return null;
  try {
    const alias = await prisma?.conversation_aliases?.findUnique?.({
      where: { legacy_id: legacyId },
      select: { uuid: true },
    });
    return normalizeUuid(alias?.uuid);
  } catch {}
  return null;
}

async function findUuidByLegacyId(legacyId) {
  if (!Number.isInteger(legacyId)) return null;
  try {
    const row = await prisma?.conversation?.findFirst?.({
      where: { legacyId },
      select: { uuid: true },
    });
    return normalizeUuid(row?.uuid);
  } catch {}
  return null;
}

async function findUuidByAliasSlug(slug) {
  const normalized = normalizeSlugCandidate(slug);
  if (!normalized) return null;
  try {
    const alias = await prisma?.conversation_aliases?.findFirst?.({
      where: { slug: normalized },
      select: { uuid: true },
    });
    return normalizeUuid(alias?.uuid);
  } catch {}
  return null;
}

async function findUuidBySlug(slug) {
  const normalized = normalizeSlugCandidate(slug);
  if (!normalized) return null;
  try {
    const row = await prisma?.conversation?.findFirst?.({
      where: { slug: normalized },
      select: { uuid: true },
    });
    return normalizeUuid(row?.uuid);
  } catch {}
  return null;
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
    let hit = extractUuidFromCandidate(loc, base);
    if (hit) return hit;

    // 2) Fallback to GET with manual redirect
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    loc = res.headers.get('location') || '';
    hit = extractUuidFromCandidate(loc, base);
    if (hit) return hit;

    // 3) If not a 3xx, parse the HTML body for meta-refresh or JS location.replace
    const body = await res.text().catch(() => '');
    const refresh = body.match(/url=([^"'>\s]+)/i)?.[1];
    hit = extractUuidFromCandidate(refresh, base);
    if (hit) return hit;

    // location.replace("/go/c/<uuid>")
    const js = body.match(/location\.(?:replace|href)\(["']([^"']+)["']\)/i)?.[1];
    const fromJs = extractUuidFromCandidate(js, base);
    if (fromJs) return fromJs;

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

  const idSet = new Set();
  const addCandidate = (value) => {
    if (value == null) return;
    if (typeof value === 'number' || typeof value === 'bigint') {
      idSet.add(String(value));
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) idSet.add(trimmed);
    }
  };

  addCandidate(inlineThread.conversation?.id);
  addCandidate(inlineThread.conversation?.slug);
  addCandidate(inlineThread.conversation_id);
  addCandidate(inlineThread.conversationId);
  addCandidate(inlineThread.conversation_slug);
  addCandidate(inlineThread.conversationSlug);
  addCandidate(inlineThread.id);
  addCandidate(inlineThread.slug);

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
    const ids = [
      m?.conversation?.id,
      m?.conversation?.slug,
      m?.conversation_id,
      m?.conversationId,
      m?.conversation_slug,
      m?.conversationSlug,
      m?.meta?.conversation_id,
      m?.meta?.conversation_slug,
      m?.headers?.conversation_id,
      m?.headers?.conversation_slug,
      m?.slug,
    ];
    for (const cand of ids) addCandidate(cand);
    for (const s of textFields(m)) {
      const q = s.match(/conversation=([0-9a-fA-F-]{36})/);
      if (q && UUID_RE.test(q[1])) return q[1].toLowerCase();
      const any = findUuidInString(s);
      if (any) return any;
    }
  }

  for (const v of idSet) {
    if (/^\d+$/.test(v)) {
      const num = Number(v);
      const aliasHit = await findUuidByAliasLegacyId(num);
      if (aliasHit) return aliasHit;
      const byNum = await findUuidByLegacyId(num);
      if (byNum) return byNum;
    }
    const aliasBySlug = await findUuidByAliasSlug(v);
    if (aliasBySlug) return aliasBySlug;
    const bySlug = await findUuidBySlug(v);
    if (bySlug) return bySlug;
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
      attempted.push('alias-legacyId');
      const aliasLegacy = await findUuidByAliasLegacyId(n);
      if (aliasLegacy) return aliasLegacy;

      attempted.push('db-legacyId');
      const byNum = await findUuidByLegacyId(n);
      if (byNum) return byNum;
    }
    attempted.push('alias-slug');
    const aliasSlug = await findUuidByAliasSlug(raw);
    if (aliasSlug) return aliasSlug;

    attempted.push('db-slug');
    const bySlug = await findUuidBySlug(raw);
    if (bySlug) return bySlug;
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
