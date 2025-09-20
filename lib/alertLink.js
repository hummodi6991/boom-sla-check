import { appUrl } from './links.js';
import { makeLinkToken } from './linkToken.js';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';
import { resolveViaInternalEndpointWithDetails } from './internalResolve.js';

let cachedTryResolveConversationUuid =
  typeof globalThis !== 'undefined' ? globalThis.tryResolveConversationUuid : undefined;
let attemptedDynamicTryResolveLoad = false;

async function getTryResolveConversationUuid() {
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.tryResolveConversationUuid === 'function'
  ) {
    cachedTryResolveConversationUuid = globalThis.tryResolveConversationUuid;
    return cachedTryResolveConversationUuid;
  }

  if (typeof cachedTryResolveConversationUuid === 'function') {
    return cachedTryResolveConversationUuid;
  }

  if (attemptedDynamicTryResolveLoad) return null;
  attemptedDynamicTryResolveLoad = true;

  try {
    const mod = await import('../apps/server/lib/conversations.js');
    const fn = mod?.tryResolveConversationUuid;
    if (typeof fn === 'function') {
      cachedTryResolveConversationUuid = fn;
      return fn;
    }
  } catch {
    // ignore dynamic import failures; we'll fall back below
  }

  return null;
}

let cachedResolveConversationUuid;
let attemptedDynamicResolveLoad = false;
async function getResolveConversationUuid() {
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.resolveConversationUuid === 'function'
  ) {
    cachedResolveConversationUuid = globalThis.resolveConversationUuid;
    return cachedResolveConversationUuid;
  }
  if (typeof cachedResolveConversationUuid === 'function') return cachedResolveConversationUuid;
  if (attemptedDynamicResolveLoad) return null;
  attemptedDynamicResolveLoad = true;
  try {
    const mod = await import('../apps/shared/lib/conversationUuid.js');
    const fn = mod?.resolveConversationUuid;
    if (typeof fn === 'function') {
      cachedResolveConversationUuid = fn;
      return fn;
    }
  } catch {}
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function defaultVerify(url) {
  try {
    const u = new URL(url);
    const isToken = /\/r\/t\/[^/]+$/.test(u.pathname);
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });

    if (isToken) {
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') || '';
        return /\/dashboard\/guest-experience\/all\b/.test(loc) && /[?&]conversation=/.test(loc);
      }
      return false;
    }

    if (res.status === 200) return true;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      return /\/login\b|\/dashboard\/guest-experience\/all\b/.test(loc);
    }
    if ([401, 403, 406].includes(res.status)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Build a verified, user-safe conversation link.
 * In strictUuid mode (default), we only return a link if a UUID is available.
 * Otherwise we return null rather than a legacy/slug dashboard link.
 * Returns { url, kind } or null if we cannot produce a verified link.
 */
export async function buildUniversalConversationLink(input = {}, opts = {}) {
  const base = (opts.baseUrl || appUrl()).replace(/\/+$/, '');
  const verify = opts.verify || defaultVerify;
  const onTokenError =
    typeof opts.onTokenError === 'function'
      ? (err, context) => {
          try {
            opts.onTokenError(err, context);
          } catch {
            // ignore handler errors
          }
        }
      : null;

  const strictUuid = opts.strictUuid !== false;

  let uuid =
    typeof input?.uuid === 'string' && UUID_RE.test(input.uuid)
      ? input.uuid.toLowerCase()
      : null;

  const fallbackRaw =
    input?.legacyId != null
      ? String(input.legacyId).trim()
      : typeof input?.slug === 'string'
      ? input.slug.trim()
      : '';

  let resolverDetail = null;

  if (!uuid && fallbackRaw) {
    const resolveConversationUuid = await getResolveConversationUuid();
    if (typeof resolveConversationUuid === 'function') {
      try {
        const maybe = await resolveConversationUuid(fallbackRaw, {
          allowMintFallback: false,
        });
        if (maybe && UUID_RE.test(maybe)) {
          uuid = maybe.toLowerCase();
        }
      } catch {}
    }
    if (!uuid) {
      resolverDetail = await resolveViaInternalEndpointWithDetails(fallbackRaw).catch(() => null);
      if (resolverDetail?.uuid && UUID_RE.test(resolverDetail.uuid)) {
        uuid = resolverDetail.uuid.toLowerCase();
      }
    }
    if (!uuid) {
      const tryResolveConversationUuid = await getTryResolveConversationUuid();
      if (typeof tryResolveConversationUuid === 'function') {
        try {
          const maybe = await tryResolveConversationUuid(fallbackRaw, {
            skipRedirectProbe: true,
          });
          if (maybe && UUID_RE.test(maybe)) uuid = maybe.toLowerCase();
        } catch {
          // ignore errors – we'll handle fallback below
        }
      }
    }
  }

  let url = null;
  let kind = 'uuid';
  let alreadyVerified = false;

  if (uuid) {
    let mintedFallback = false;
    if (fallbackRaw) {
      if (!resolverDetail) {
        resolverDetail = await resolveViaInternalEndpointWithDetails(fallbackRaw).catch(
          () => null
        );
      }
      if (resolverDetail?.uuid && UUID_RE.test(resolverDetail.uuid)) {
        uuid = resolverDetail.uuid.toLowerCase();
      }
      if (resolverDetail?.minted) {
        mintedFallback = true;
      } else if (!UUID_RE.test(fallbackRaw)) {
        try {
          const mintedGuess = mintUuidFromRaw(fallbackRaw);
          if (mintedGuess && mintedGuess.toLowerCase() === uuid) {
            mintedFallback = true;
          }
        } catch {
          // ignore minting failures; fall back to token/deep-link path below
        }
      }
      if (mintedFallback) {
        kind = 'resolver';
        url = /^[0-9]+$/.test(fallbackRaw)
          ? `${base}/r/legacy/${encodeURIComponent(fallbackRaw)}`
          : `${base}/r/conversation/${encodeURIComponent(fallbackRaw)}`;
      }
    }

    if (!url) {
      // Prefer token link; if mint fails OR token verification fails, degrade to deep link.
      let candidate = null;
      try {
        const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
        const token = makeLinkToken({ uuid, exp });
        candidate = `${base}/r/t/${token}`;
      } catch (err) {
        onTokenError?.(err, { uuid });
      }
      if (candidate) {
        const ok = await verify(candidate);
        if (ok) {
          url = candidate;
          alreadyVerified = true;
        } else {
          // degrade to deep link if token doesn't verify in the target environment
          const deep = `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(
            uuid
          )}`;
          const deepOk = await verify(deep);
          if (!deepOk) return null;
          url = deep;
          alreadyVerified = true;
        }
      } else {
        // token mint failed; use deep link
        const deep = `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(
          uuid
        )}`;
        const deepOk = await verify(deep);
        if (!deepOk) return null;
        url = deep;
        alreadyVerified = true;
      }
    }
  } else if (fallbackRaw) {
    // UUID not available.
    // In strict mode we refuse to produce a link to guarantee deep-link correctness.
    if (strictUuid) {
      return null;
    }
    // Non-strict mode: keep the old legacy dashboard links behavior.
    if (/^[0-9]+$/.test(fallbackRaw)) {
      url = `${base}/dashboard/guest-experience/all?legacyId=${encodeURIComponent(
        fallbackRaw
      )}`;
    } else {
      url = `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(
        fallbackRaw
      )}`;
    }
    kind = 'legacy';
  }

  if (!url) return null;
  if (!alreadyVerified) {
    const ok = await verify(url);
    if (!ok) return null;
  }
  return { url, kind };
}
