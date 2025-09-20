import { buildUniversalConversationLink } from './alertLink.js';
import { conversationIdDisplay } from './links.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const LEGACY_RE = /^[0-9]+$/;

const UUID_KEYS = [
  'conversation_uuid',
  'conversationUuid',
  'conversationUUID',
  'uuid',
  'conversationId',
  'conversation_id',
  'conversationID',
  'conversation',
  'public_id',
  'publicId',
  'external_id',
  'externalId',
  'id',
];

const LEGACY_KEYS = [
  'legacyId',
  'legacy_id',
  'legacyID',
  'legacyConversationId',
  'legacy_conversation_id',
  'conversationId',
  'conversation_id',
  'conversationID',
  'id',
];

const SLUG_KEYS = [
  'slug',
  'conversationSlug',
  'conversation_slug',
  'conversation',
  'public_id',
  'publicId',
  'external_id',
  'externalId',
];

const NESTED_KEYS = [
  'conversation',
  'payload',
  'data',
  'event',
  'details',
  'meta',
  'context',
];

const stripCtl = (value) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, '') : value;

const clean = (value) => {
  if (value == null) return '';
  const stripped = stripCtl(value);
  if (typeof stripped === 'string') return stripped.trim();
  if (typeof stripped === 'number' && Number.isFinite(stripped)) return String(Math.trunc(stripped));
  if (typeof stripped === 'bigint') return stripped.toString();
  return '';
};

const looksLikeSlug = (value) => {
  if (!value) return false;
  if (UUID_RE.test(value) || LEGACY_RE.test(value)) return false;
  if (/\s/.test(value)) return false;
  return value.length >= 3 && value.length <= 128;
};

const pickFromKeys = (record, keys, predicate) => {
  for (const key of keys) {
    if (!(key in record)) continue;
    const raw = clean(record[key]);
    if (!raw) continue;
    if (predicate(raw, key)) return { value: raw, key };
  }
  return null;
};

const inspectRecord = (record) => {
  const uuid = pickFromKeys(record, UUID_KEYS, (value) => UUID_RE.test(value));
  const legacy = pickFromKeys(record, LEGACY_KEYS, (value, key) => {
    if (!LEGACY_RE.test(value)) return false;
    // Avoid treating UUID-style keys as numeric IDs when the value already matches a UUID.
    if (UUID_KEYS.includes(key) && UUID_RE.test(value)) return false;
    return true;
  });
  let slug = pickFromKeys(record, SLUG_KEYS, (value) => looksLikeSlug(value));
  if (!slug) {
    slug = pickFromKeys(record, ['id', 'conversation'], (value) => looksLikeSlug(value));
  }

  const normalized = {
    uuid: uuid ? uuid.value.toLowerCase() : null,
    legacyId: legacy ? legacy.value : null,
    slug: slug ? slug.value : null,
    display: uuid?.value || legacy?.value || slug?.value || null,
  };
  return normalized;
};

const gatherRecords = (input) => {
  const records = [];
  const seen = new Set();
  const stack = [];
  if (input && typeof input === 'object') stack.push(input);
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    records.push(current);
    for (const key of NESTED_KEYS) {
      const candidate = current[key];
      if (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
        stack.push(candidate);
      }
    }
  }
  return records;
};

const mergeCandidates = (candidates) => {
  const result = { uuid: null, legacyId: null, slug: null, display: null };
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!result.uuid && candidate.uuid) result.uuid = candidate.uuid;
    if (!result.legacyId && candidate.legacyId) result.legacyId = candidate.legacyId;
    if (!result.slug && candidate.slug) result.slug = candidate.slug;
    if (!result.display && candidate.display) result.display = candidate.display;
  }
  if (!result.display) {
    result.display = result.uuid || result.legacyId || result.slug || null;
  }
  if (!result.uuid && !result.legacyId && !result.slug) return null;
  return result;
};

export function normalizeAlertLinkInput(input) {
  if (input == null) return null;
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'bigint') {
    const raw = clean(input);
    if (!raw) return null;
    if (UUID_RE.test(raw)) {
      return { uuid: raw.toLowerCase(), legacyId: null, slug: null, display: raw };
    }
    if (LEGACY_RE.test(raw)) {
      return { uuid: null, legacyId: raw, slug: null, display: raw };
    }
    if (looksLikeSlug(raw)) {
      return { uuid: null, legacyId: null, slug: raw, display: raw };
    }
    return null;
  }
  if (typeof input !== 'object') return null;
  const records = gatherRecords(input);
  const candidates = records.map((record) => inspectRecord(record));
  const merged = mergeCandidates(candidates);
  if (!merged) return null;
  return merged;
}

export async function buildAlertConversationLink(input, opts = {}) {
  const normalized = normalizeAlertLinkInput(input);
  if (!normalized) return null;
  const builderInput = {
    uuid: normalized.uuid || undefined,
    legacyId: normalized.legacyId || undefined,
    slug: normalized.slug || undefined,
  };
  const built = await buildUniversalConversationLink(builderInput, opts);
  if (!built) return null;
  const id = normalized.display || normalized.legacyId || normalized.slug || undefined;
  const idDisplay = conversationIdDisplay({ uuid: normalized.uuid || undefined, id });
  return {
    ...built,
    uuid: normalized.uuid || null,
    legacyId: normalized.legacyId || null,
    slug: normalized.slug || null,
    idDisplay,
  };
}

export const __test__ = {
  clean,
  looksLikeSlug,
  inspectRecord,
  gatherRecords,
};
