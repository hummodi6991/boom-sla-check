import { buildAlertConversationLink, normalizeAlertLinkInput } from './conversationLink.js';
import { resolveConversationUuidHedged as defaultResolveConversationUuid } from '../apps/shared/lib/conversationUuid.js';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const LEGACY_RE = /^\d+$/;

const cleanCandidate = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'bigint') return value.toString();
  return '';
};

const dedupe = (values) => {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = cleanCandidate(value);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
};

const looksLikeUuid = (value) => UUID_RE.test(value || '');
const looksLikeLegacy = (value) => LEGACY_RE.test(value || '');

const mergeConversationFields = (target, additions) => {
  if (!additions || typeof additions !== 'object') return;
  target.conversation = target.conversation || {};
  for (const [key, value] of Object.entries(additions)) {
    if (value == null) continue;
    if (target.conversation[key] == null) target.conversation[key] = value;
  }
};

export async function ensureAlertConversationLink(params = {}, opts = {}) {
  const {
    primary = null,
    additional = [],
    inlineThread = null,
    fetchFirstMessage = undefined,
  } = params;

  const {
    baseUrl,
    strictUuid,
    verify,
    onTokenError,
    resolveUuid = defaultResolveConversationUuid,
  } = opts;

  const candidateValues = dedupe([primary, ...(Array.isArray(additional) ? additional : [])]);

  let inlineNormalized = null;
  if (inlineThread && typeof inlineThread === 'object') {
    inlineNormalized = normalizeAlertLinkInput({ context: inlineThread });
    if (inlineNormalized?.uuid) candidateValues.push(inlineNormalized.uuid);
    if (inlineNormalized?.legacyId) candidateValues.push(inlineNormalized.legacyId);
    if (inlineNormalized?.slug) candidateValues.push(inlineNormalized.slug);
  }

  const candidates = dedupe(candidateValues);

  let uuid = inlineNormalized?.uuid ? inlineNormalized.uuid.toLowerCase() : null;
  let legacyId = inlineNormalized?.legacyId || null;
  let slug = inlineNormalized?.slug || null;

  for (const value of candidates) {
    if (!uuid && looksLikeUuid(value)) uuid = value.toLowerCase();
    if (!legacyId && looksLikeLegacy(value)) legacyId = value;
    if (!slug && !looksLikeUuid(value) && !looksLikeLegacy(value)) slug = value;
  }

  const resolverOpts = {
    inlineThread,
    fetchFirstMessage,
    allowMintFallback: true,
  };

  if (!uuid) {
    for (const raw of candidates) {
      if (looksLikeUuid(raw)) {
        uuid = raw.toLowerCase();
        break;
      }
      try {
        const maybe = await resolveUuid(raw, resolverOpts);
        if (maybe) {
          uuid = maybe.toLowerCase();
          break;
        }
      } catch {
        // ignore resolver errors – we'll fall back to minting below
      }
    }
  }

  const mintSources = dedupe([
    ...candidates,
    legacyId,
    slug,
  ]);

  let mintedSource = null;
  if (!uuid) {
    for (const raw of mintSources) {
      try {
        const minted = mintUuidFromRaw(raw);
        if (minted) {
          uuid = minted.toLowerCase();
          mintedSource = raw;
          break;
        }
      } catch {
        // ignore minting failures and continue to next candidate
      }
    }
  } else {
    for (const raw of mintSources) {
      try {
        const minted = mintUuidFromRaw(raw);
        if (minted && minted.toLowerCase() === uuid) {
          mintedSource = raw;
          break;
        }
      } catch {
        // ignore minting failures
      }
    }
  }

  if (!uuid) return null;

  if (!legacyId && mintedSource && looksLikeLegacy(mintedSource)) legacyId = mintedSource;
  if (!slug && mintedSource && !looksLikeLegacy(mintedSource) && !looksLikeUuid(mintedSource)) slug = mintedSource;

  const builderInput = {
    conversation_uuid: uuid,
    conversationUuid: uuid,
    uuid,
  };

  mergeConversationFields(builderInput, { uuid });

  if (legacyId) {
    builderInput.legacyId = legacyId;
    builderInput.legacy_id = legacyId;
    builderInput.conversation_id = legacyId;
    builderInput.conversationId = legacyId;
    builderInput.id = legacyId;
    mergeConversationFields(builderInput, { id: legacyId });
  }

  if (slug) {
    builderInput.slug = slug;
    builderInput.conversation_slug = slug;
    builderInput.conversationSlug = slug;
    builderInput.public_id = slug;
    mergeConversationFields(builderInput, { slug });
  }

  if (inlineThread && typeof inlineThread === 'object') {
    builderInput.context = inlineThread;
  }

  const built = await buildAlertConversationLink(builderInput, {
    baseUrl,
    strictUuid,
    verify,
    onTokenError,
  });
  if (!built) return null;

  return { ...built, uuid: uuid.toLowerCase() };
}

export const __test__ = {
  cleanCandidate,
  dedupe,
  looksLikeUuid,
  looksLikeLegacy,
};
