// Heuristic resolution guard for SLA alerting.
// Returns true when the conversation/thread looks resolved/closed/archived.
// Designed to cope with heterogeneous payloads (different backends/shapes).
const RESOLVED_TOKENS = [
  'resolved',
  'closed',
  'archived',
  'done',
  'completed',
  'complete',
  'solved',
  'finished',
  'ended',
];

function isTrue(v) {
  if (v === true) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function isFalse(v) {
  if (v === false) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'false' || s === '0' || s === 'no';
}

function parseTs(v) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
}

function tok(v) {
  return String(v ?? '').toLowerCase();
}

function any(obj, keys) {
  for (const k of keys) {
    if (obj && typeof obj === 'object' && k in obj) return obj[k];
  }
  return undefined;
}

function flagsResolved(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const status = any(obj, ['status', 'state', 'conversation_status', 'conversationState']);
  const open = any(obj, ['open', 'is_open', 'isOpen']);
  if (isFalse(open)) return true;
  const flagKeys = [
    'resolved', 'is_resolved', 'isResolved',
    'closed', 'is_closed', 'isClosed',
    'archived', 'is_archived', 'isArchived',
  ];
  for (const k of flagKeys) if (isTrue(obj[k])) return true;
  const s = tok(status);
  if (s && RESOLVED_TOKENS.some((t) => s.includes(t))) return true;
  const tsKeys = ['resolved_at', 'resolvedAt', 'closed_at', 'closedAt', 'archived_at', 'archivedAt', 'done_at', 'doneAt'];
  for (const k of tsKeys) if (parseTs(obj[k])) return true;
  return false;
}

function scanResolved(obj, seen = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return false;
  seen.add(obj);
  if (flagsResolved(obj)) return true;
  // Common nesting shapes
  const containers = ['conversation', 'data', 'payload', 'result', 'meta', 'context', 'details', 'info', 'thread'];
  for (const key of containers) {
    const v = obj[key];
    if (v && typeof v === 'object' && scanResolved(v, seen, depth + 1)) return true;
  }
  return false;
}

function messageMarksResolved(m) {
  if (!m || typeof m !== 'object') return false;
  const moduleVal = tok(m.module ?? m.module_type);
  const typeVal = tok(m.msg_type ?? m.type);
  const body = tok(m.body ?? m.body_text ?? m.text ?? m.message ?? m.content);
  const combo = `${moduleVal} ${typeVal} ${body}`;
  // Look for system/workflow/status changes that clearly resolve/close
  if (/(system|workflow|status|policy|automation)/.test(moduleVal + typeVal) &&
      /(resolve|closed|archiv|done|complete|solved)/.test(combo)) {
    return true;
  }
  return false;
}

export function isConversationResolved(context, messages) {
  // 1) Structured flags & timestamps on the object(s)
  if (scanResolved(context)) return true;
  // 2) Recent system/status messages that close the thread
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0 && i > list.length - 20; i -= 1) {
    if (messageMarksResolved(list[i])) return true;
  }
  return false;
}

