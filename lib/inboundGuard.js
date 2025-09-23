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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const NUMERIC_RE = /^\d+$/;

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
  for (const raw of flattenCandidates(candidates)) {
    const normalized = normalizeId(raw);
    if (!normalized) continue;
    if (NUMERIC_RE.test(normalized)) return normalized;
    if (UUID_RE.test(normalized.toLowerCase())) return normalized.toLowerCase();
  }
  return null;
}

export async function ensureVisibleInboundMessage(conversationId, { logger, context, query } = {}) {
  const normalized = normalizeId(conversationId);
  if (!normalized) {
    return { ok: true, reason: 'missing_id' };
  }

  const runQuery = typeof query === 'function'
    ? query
    : (text, params) => db.oneOrNone(text, params);

  try {
    const inbound = await runQuery(LAST_VISIBLE_INBOUND_SQL, [normalized]);
    if (!inbound) {
      if (logger?.warn) logger.warn('Skip SLA email: no visible inbound message', { conversationId: normalized, ...context });
      return { ok: false, reason: 'no_visible_inbound' };
    }
    return { ok: true, reason: 'found', inbound };
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

