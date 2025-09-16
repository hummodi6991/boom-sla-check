import { makeConversationLink } from '../../shared/lib/links';
import { makeLinkToken } from '../../shared/lib/linkToken';
import { verifyConversationLink } from '../../shared/lib/verifyLink';
import { signResolve } from '../../shared/lib/resolveSign';
import { metrics } from '../../../lib/metrics';
import crypto from 'node:crypto';

export async function buildAlertEmail(
  event: { conversation_uuid?: string; legacyId?: number | string; slug?: string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const logger = deps?.logger;
  const preferVerify = deps?.verify ?? verifyConversationLink;
  const base = (process.env.APP_URL || 'https://app.boomnow.com').replace(/\/+$/, '');

  // 1) Prefer UUID present on the event
  let uuid = typeof event?.conversation_uuid === 'string' ? event.conversation_uuid : null;

  const fallbackRaw = (() => {
    if (event?.legacyId != null) return String(event.legacyId).trim();
    if (typeof event?.slug === 'string') return event.slug.trim();
    return '';
  })();

  // 2) If missing, resolve at *send time* via internal signed endpoint
  async function resolveUuid(idOrSlug: string): Promise<string | null> {
    const raw = (idOrSlug || '').trim();
    if (!raw) return null;
    const secret = process.env.RESOLVE_SECRET || '';
    const host = (process.env.RESOLVE_BASE_URL || process.env.APP_URL || base).replace(/\/+$/, '');
    if (!secret) return null;
    const ts = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const sig = signResolve(raw, ts, nonce, secret);
    const url = `${host}/api/internal/resolve-conversation?id=${encodeURIComponent(raw)}&ts=${ts}&nonce=${nonce}&sig=${sig}`;
    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      const u = json?.uuid;
      return typeof u === 'string' && /^[0-9a-f-]{36}$/i.test(u) ? u.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  if (!uuid && fallbackRaw) {
    uuid = await resolveUuid(fallbackRaw);
  }

  if (!uuid && !fallbackRaw) {
    logger?.warn?.({ event }, 'skip alert: missing resolvable uuid');
    metrics.increment('alerts.skipped_missing_uuid');
    return null;
  }

  const fallbackUrl = fallbackRaw
    ? `${base}${/^[0-9]+$/.test(fallbackRaw) ? '/r/legacy/' : '/r/conversation/'}${encodeURIComponent(fallbackRaw)}`
    : null;

  // 3) Mint a short token link that is self-contained and DB-independent on click
  let url: string | null = null;
  try {
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days
    if (uuid) {
      const token = makeLinkToken({ uuid, exp });
      url = `${base}/r/t/${token}`;
    }
  } catch (err) {
    logger?.warn?.({ uuid, err }, 'link_token_generation_failed');
  }
  if (!url && uuid) url = makeConversationLink({ uuid });
  let legacyFallback = false;
  if (!url && fallbackUrl) {
    url = fallbackUrl;
    legacyFallback = true;
  }
  if (!url) {
    logger?.warn?.({ event }, 'skip alert: unable to build link');
    metrics.increment('alerts.skipped_link_preflight');
    return null;
  }

  const ok = await preferVerify(url);
  if (!ok) {
    logger?.warn?.({ url }, 'link_verification_failed');
    metrics.increment('alerts.skipped_link_preflight');
    return null;
  }
  metrics.increment(legacyFallback ? 'alerts.sent_with_legacy_shortlink' : 'alerts.sent_with_uuid');
  return `<p>Alert for conversation <a href="${url}">${url}</a></p>`;
}
