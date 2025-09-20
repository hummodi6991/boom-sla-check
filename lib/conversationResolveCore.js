import { v5 as uuidv5, validate as uuidValidate } from 'uuid';
import { tryResolveConversationUuid as tryResolve } from '../apps/server/lib/conversations.js';

// Default namespace used when no explicit environment override is provided.
export const CONVERSATION_UUID_NAMESPACE_DEFAULT = '3f3aa693-5b5d-4f6a-9c8e-7b7a1d1d8b7a';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizePemString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentifier(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.trunc(raw));
  if (typeof raw === 'bigint') return raw.toString();
  return String(raw).trim();
}

function normalizeNamespace(candidate) {
  const normalized = normalizePemString(candidate);
  if (normalized && uuidValidate(normalized)) return normalized.toLowerCase();
  return null;
}

export function conversationUuidNamespace() {
  const envCandidates = [
    process.env.CONVERSATION_UUID_NAMESPACE,
    process.env.CONV_UUID_NAMESPACE,
  ];
  for (const candidate of envCandidates) {
    const normalized = normalizeNamespace(candidate);
    if (normalized) return normalized;
  }
  return CONVERSATION_UUID_NAMESPACE_DEFAULT;
}

export function isUuid(value) {
  return UUID_RE.test(String(value ?? ''));
}

export function mintUuidFromLegacyId(legacyId) {
  if (!Number.isInteger(legacyId)) throw new Error('legacyId must be integer');
  return uuidv5(`legacy:${legacyId}`, conversationUuidNamespace());
}

export function mintUuidFromSlug(slug) {
  const trimmed = normalizeIdentifier(slug);
  if (!trimmed) throw new Error('slug required');
  return uuidv5(`slug:${trimmed}`, conversationUuidNamespace());
}

export function mintUuidFromRaw(raw) {
  const normalized = normalizeIdentifier(raw);
  if (!normalized) return null;
  if (isUuid(normalized)) return normalized.toLowerCase();
  if (/^\d+$/.test(normalized)) return mintUuidFromLegacyId(Number(normalized));
  return mintUuidFromSlug(normalized);
}

function deriveMintedResult(raw) {
  const minted = mintUuidFromRaw(raw);
  if (!minted) return null;
  const normalized = normalizeIdentifier(raw);
  const mintedUuid = minted.toLowerCase();
  const mintedFlag = !isUuid(normalized) || mintedUuid !== normalized.toLowerCase();
  return { uuid: mintedUuid, minted: mintedFlag };
}

export async function resolveConversationUuid(raw, opts = {}) {
  const normalized = normalizeIdentifier(raw);
  if (!normalized) return null;

  if (isUuid(normalized)) {
    return { uuid: normalized.toLowerCase(), minted: false };
  }

  const { allowMintFallback = false, skipRedirectProbe = true, ...passThrough } = opts ?? {};

  try {
    const result = await tryResolve(normalized, { skipRedirectProbe, ...passThrough });
    if (result && isUuid(result)) {
      return { uuid: result.toLowerCase(), minted: false };
    }
  } catch {
    // ignore lookup failures and fall through to minting
  }

  if (allowMintFallback) {
    return deriveMintedResult(normalized);
  }

  return null;
}

export function conversationDeepLink(uuid, base) {
  const normalizedUuid = mintUuidFromRaw(uuid);
  if (!normalizedUuid || !isUuid(normalizedUuid)) {
    throw new Error('conversationDeepLink: uuid required');
  }
  const path = `/dashboard/guest-experience/all?conversation=${encodeURIComponent(
    normalizedUuid.toLowerCase(),
  )}`;
  if (!base) return path;
  const trimmedBase = normalizeIdentifier(base).replace(/\/+$/, '');
  if (!trimmedBase) return path;
  try {
    const url = new URL(trimmedBase);
    const pathname = url.pathname.replace(/\/+$/, '');
    const [targetPath, targetQuery] = path.split('?');
    url.pathname = `${pathname}${targetPath}`;
    url.search = targetQuery ? `?${targetQuery}` : '';
    url.hash = '';
    return url.toString();
  } catch {
    return `${trimmedBase}${path}`;
  }
}

export const __test__ = {
  normalizeIdentifier,
  deriveMintedResult,
};
