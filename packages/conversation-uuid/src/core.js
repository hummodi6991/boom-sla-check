import { tryResolveConversationUuid as tryResolve } from './tryResolve.js';
import { deriveMintedResult, mintUuidFromRaw } from './mint.js';
import { isUuid, normalizeIdentifier } from './utils.js';

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
  const lowerUuid = normalizedUuid.toLowerCase();
  const path = `/go/c/${encodeURIComponent(lowerUuid)}`;
  if (!base) return path;
  const trimmedBase = normalizeIdentifier(base).replace(/\/+$/, '');
  if (!trimmedBase) return path;
  try {
    const url = new URL(path, `${trimmedBase}/`);
    url.search = '';
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
