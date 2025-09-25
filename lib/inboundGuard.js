import { db, DbNotConfiguredError } from './postgres.js';

export const LAST_VISIBLE_INBOUND_SQL = `
  select id, created_at
  from messages
  where conversation_id = $1
    and author_role = 'guest'
    and state = 'visible'
    and kind in ('chat','sms','email','whatsapp','voice','file','image','text')
  order by created_at desc
  limit 1
`;

// Relaxed fallback: any guest-like author role, regardless of state/kind.
export const LAST_GUEST_ANY_STATE_SQL = `
  select id, created_at
  from messages
  where conversation_id = $1
    and (author_role in ('guest','customer','user','end_user','visitor','client','contact'))
  order by created_at desc
  limit 1
`;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const NUMERIC_RE = /^\d+$/;

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function flattenCandidates(values = []) {
  const out = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      out.push(...flattenCandidates(value));
    } else {
      out.push(value);
    }
  }
  return out;
}

function normalizeId(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'bigint') return value.toString();
  return String(value).trim();
}

export function pickConversationIdForGuard(candidates = []) {
  // Flatten + normalize once
  const flat = flattenCandidates(candidates).map(normalizeId).filter(Boolean);
  // Prefer numeric conversation_id anywhere in the list
  const numeric = flat.find(v => NUMERIC_RE.test(v));
  if (numeric) return numeric;
  // Fallback to a canonical lowercase UUID if present
  const uuid = flat.find(v => UUID_RE.test(String(v).toLowerCase()));
  return uuid ? String(uuid).toLowerCase() : null;
}

export function hasGuestInbound(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  for (const msg of messages) {
    const isAI = Boolean(firstDefined(msg.is_ai, msg.generated_by_ai, msg.ai_generated, msg?.meta?.is_ai));
    if (isAI) continue;
    const dir = String(firstDefined(msg.direction, msg.message_direction, msg?.meta?.direction) || '').toLowerCase();
    if (dir === 'inbound') return true;
    const roleish = String(firstDefined(
      msg.role, msg.author_role, msg.sender_role, msg.from_role,
      msg?.sender?.role, msg?.author?.role, msg?.from?.role,
      msg.by, msg.senderType, msg.sender_type
    ) || '').toLowerCase().replace(/[^a-z_]/g,'');
    if (['guest','customer','user','end_user','visitor','client','contact'].includes(roleish)) return true;
  }
  return false;
}

export async function ensureVisibleInboundMessage(conversationId, { logger, context, query, messages } = {}) {
  const normalized = normalizeId(conversationId);
  if (!normalized) {
    return { ok: true, reason: 'missing_id' };
  }

  // Soft guard: if the in-memory thread already shows inbound guest activity,
  // do not block on DB idiosyncrasies (state/kind/channel variants).
  if (hasGuestInbound(messages)) {
    return { ok: true, reason: 'found_in_memory' };
  }

  const runQuery = typeof query === 'function'
    ? query
    : (text, params) => db.oneOrNone(text, params);

  try {
    // Try strict query first…
    const inbound = await runQuery(LAST_VISIBLE_INBOUND_SQL, [normalized]);
    if (inbound) return { ok: true, reason: 'found', inbound };
    // …then relaxed fallback.
    const relaxed = await runQuery(LAST_GUEST_ANY_STATE_SQL, [normalized]);
    if (relaxed) return { ok: true, reason: 'found_any_state', inbound: relaxed };
    if (logger?.warn) logger.warn('Skip SLA email: no visible inbound message', { conversationId: normalized, ...context });
    return { ok: false, reason: 'no_visible_inbound' };
  } catch (error) {
    if (error instanceof DbNotConfiguredError || error?.code === 'PG_NOT_CONFIGURED') {
      return { ok: true, reason: 'db_not_configured' };
    }
    if (logger?.warn) {
      logger.warn(
        'Inbound message guard failed; proceeding without DB confirmation',
        { conversationId: normalized, error: error?.message || String(error), ...context },
      );
    }
    return { ok: true, reason: 'error', error };
  }
}

