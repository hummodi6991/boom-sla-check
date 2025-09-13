import { isUuid } from '../../shared/lib/uuid.js';
import { prisma } from '../../../lib/db.js';

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

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

  // direct fields
  const direct =
    inlineThread.conversation_uuid ||
    inlineThread.conversationUuid ||
    inlineThread.uuid ||
    inlineThread.conversation?.uuid;
  const directHit = firstUuid(String(direct || ''));
  if (directHit) return directHit;

  // message arrays we might receive
  const msgs =
    (Array.isArray(inlineThread.messages) && inlineThread.messages) ||
    (Array.isArray(inlineThread.thread) && inlineThread.thread) ||
    (Array.isArray(inlineThread.items) && inlineThread.items) || [];

  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;

    // structured candidates
    const cands = [
      m.conversation_uuid,
      m.conversationUuid,
      m.thread_uuid,
      m.uuid,
      m.conversation?.uuid,
      m.thread?.uuid,
    ];
    for (const c of cands) {
      const hit = firstUuid(String(c || ''));
      if (hit) return hit;
    }

    // urls / bodies containing ?conversation=<uuid> or raw uuid
    for (const s of textFields(m)) {
      const q = s.match(/conversation=([0-9a-fA-F-]{36})/);
      if (q && UUID_RE.test(q[1])) return q[1].toLowerCase();
      const any = firstUuid(s);
      if (any) return any;
    }
  }

  // numeric/slug ids inside messages → map via DB
  const idSet = new Set();
  for (const m of msgs) {
    const vals = [
      m?.conversation?.id,
      m?.conversation_id,
      m?.meta?.conversation_id,
      m?.headers?.conversation_id,
    ].filter(v => v != null);
    for (const v of vals) idSet.add(String(v));
  }
  for (const v of idSet) {
    if (/^\d+$/.test(v)) {
      const row = await prisma.conversation.findFirst({
        where: { legacyId: Number(v) },
        select: { uuid: true },
      });
      if (row?.uuid && isUuid(row.uuid)) return row.uuid.toLowerCase();
    }
    const bySlug = await prisma.conversation.findFirst({
      where: { slug: v },
      select: { uuid: true },
    });
    if (bySlug?.uuid && isUuid(bySlug.uuid)) return bySlug.uuid.toLowerCase();
  }

  return null;
}

export async function tryResolveConversationUuid(idOrUuid, opts = {}) {
  const raw = String(idOrUuid ?? '').trim();
  if (!raw) return null;

  // 1) already uuid
  if (isUuid(raw)) return raw.toLowerCase();

  // 2) db lookups (legacy numeric / slug)
  try {
    if (prisma?.conversation?.findFirst) {
      const n = Number(raw);
      if (Number.isInteger(n)) {
        const byNum = await prisma.conversation.findFirst({
          where: { legacyId: n },
          select: { uuid: true },
        });
        if (byNum?.uuid && isUuid(byNum.uuid)) return byNum.uuid.toLowerCase();
      }
      const bySlug = await prisma.conversation.findFirst({
        where: { slug: raw },
        select: { uuid: true },
      });
      if (bySlug?.uuid && isUuid(bySlug.uuid)) return bySlug.uuid.toLowerCase();
    }
  } catch { /* ignore, fall through */ }

  // 3) mine inline thread
  const mined = await tryUuidFromInlineThread(opts.inlineThread);
  if (mined) return mined;

  return null;
}
