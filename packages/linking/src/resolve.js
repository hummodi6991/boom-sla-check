import { tryResolveConversationUuid } from '../../../apps/server/lib/conversations.js';
import {
  resolveViaInternalEndpoint,
  resolveViaPublicEndpoint,
} from '../../../lib/internalResolve.js';
import { isUuid, mintUuidFromRaw } from '../../../apps/shared/lib/canonicalConversationUuid.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function normalizeUuid(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeRawCandidate(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

export async function resolveConversation(input = {}) {
  const uuidDirect = normalizeUuid(input.uuid);
  if (uuidDirect) {
    return { uuid: uuidDirect };
  }

  const legacyId = normalizeRawCandidate(input.legacyId);
  const slug = normalizeRawCandidate(input.slug);
  const raw = legacyId || slug;
  if (!raw) return null;

  const rawUuid = normalizeUuid(raw);
  if (rawUuid) {
    return { uuid: rawUuid };
  }

  const opts = {
    inlineThread: input.inlineThread,
    fetchFirstMessage: input.fetchFirstMessage,
    skipRedirectProbe: input.skipRedirectProbe,
    onDebug: input.onDebug,
  };

  try {
    const fromCore = await tryResolveConversationUuid(raw, opts);
    if (fromCore && isUuid(fromCore)) {
      return { uuid: fromCore.toLowerCase() };
    }
  } catch {
    // ignore and continue to other paths
  }

  try {
    const viaInternal = await resolveViaInternalEndpoint(raw);
    if (viaInternal && isUuid(viaInternal)) {
      return { uuid: viaInternal.toLowerCase() };
    }
  } catch {
    // continue
  }

  try {
    const viaPublic = await resolveViaPublicEndpoint(raw);
    if (viaPublic && isUuid(viaPublic)) {
      return { uuid: viaPublic.toLowerCase() };
    }
  } catch {
    // continue
  }

  if (input.allowMintFallback !== false) {
    try {
      const minted = mintUuidFromRaw(raw);
      if (minted && isUuid(minted)) {
        return { uuid: minted.toLowerCase() };
      }
    } catch {
      // ignore mint failures
    }
  }

  return null;
}
