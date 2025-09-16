import crypto from 'node:crypto';
import { appUrl } from './links.js';
import { makeLinkToken } from './linkToken.js';
import { signResolve } from '../apps/shared/lib/resolveSign.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function defaultVerify(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    if (res.status === 200) return true;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      if (loc.includes('/login') || loc.includes('/dashboard/guest-experience/cs')) {
        return true;
      }
    }
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
      url = `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(
        uuid
      )}`;
    }
  } else if (fallbackRaw) {
    url = `${base}${
      /^[0-9]+$/.test(fallbackRaw) ? '/r/legacy/' : '/r/conversation/'
    }${encodeURIComponent(fallbackRaw)}`;
    kind = 'legacy';
  }

  if (!url) return null;
  const ok = await verify(url);
  if (!ok) return null;
  return { url, kind };
}
