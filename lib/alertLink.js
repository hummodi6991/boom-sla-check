import crypto from 'node:crypto';
import { appUrl } from './links.js';
import { makeLinkToken } from './linkToken.js';
import { signResolve } from '../apps/shared/lib/resolveSign.js';

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function defaultVerify(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    // Accept a direct success
    if (res.status === 200) return true;
    // Accept redirects to login or dashboard
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (loc.includes('/login') || loc.includes('/dashboard/guest-experience/all')) {
        return true;
      }
    }
    // Treat common unauthenticated responses as valid
    if ([401, 403, 406].includes(res.status)) return true;
    return false;
  } catch {
    return false;
  }
}

async function resolveUuid(idOrSlug, base) {
  const raw = String(idOrSlug || '').trim();
  if (!raw) return null;
  const secret = process.env.RESOLVE_SECRET || '';
  const host = (process.env.RESOLVE_BASE_URL || base).replace(/\/+$/, '');
  if (!secret) return null;
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  const sig = signResolve(raw, ts, nonce, secret);
  const url = `${host}/api/internal/resolve-conversation?id=${encodeURIComponent(
    raw
  )}&ts=${ts}&nonce=${nonce}&sig=${sig}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const u = json?.uuid;
    return typeof u === 'string' && UUID_RE.test(u) ? u.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Build a verified, user-safe conversation link.
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

  if (!uuid && fallbackRaw) {
    uuid = await resolveUuid(fallbackRaw, base);
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

  if (uuid) {
    // Prefer a short token link; fall back to deep link if token mint fails
    try {
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = makeLinkToken({ uuid, exp });
      url = `${base}/r/t/${token}`;
    } catch (err) {
      onTokenError?.(err, { uuid });
      url = `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(
        uuid
      )}`;
    }
  } else if (fallbackRaw) {
    // When we cannot resolve a UUID, fall back to a dashboard link instead of
    // using legacy short-links, which do not work without JS enabled.
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
  const ok = await verify(url);
  if (!ok) return null;
  return { url, kind };
}
