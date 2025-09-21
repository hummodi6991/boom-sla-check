export const trim = (s) => s.replace(/\/+$/, '');
// Remove ASCII control chars and stray whitespace to prevent broken links in emails
const stripCtlAndTrim = (s) =>
  String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();

export const appUrl = () =>
  trim(stripCtlAndTrim(process.env.APP_URL ?? 'https://app.boomnow.com'));

export const alertLinkBase = () => {
  const rawBase =
    process.env.ALERT_LINK_BASE ?? process.env.APP_URL ?? 'https://app.boomnow.com';
  return trim(stripCtlAndTrim(rawBase));
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

const normalizeBaseUrl = (input) => {
  const raw = input ? String(input) : appUrl()
  return trim(stripCtlAndTrim(raw))
}

export function makeConversationLink({ uuid, baseUrl }) {
  const base = normalizeBaseUrl(baseUrl)
  if (uuid && UUID_RE.test(String(uuid))) {
    const normalized = String(uuid).toLowerCase()
    return `${base}/go/c/${encodeURIComponent(normalized)}`
  }
  return null
}

const sanitizeIdentifier = (value) => {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    const trimmed = stripCtlAndTrim(value);
    return trimmed || null;
  }
  return null;
};

export function buildResolverLink({ identifier, uuid, baseUrl } = {}) {
  const base = normalizeBaseUrl(baseUrl ?? alertLinkBase());
  const primary = sanitizeIdentifier(identifier) ?? sanitizeIdentifier(uuid);
  if (!base || !primary) return null;
  const parts = [`${base}/boom/open/conv/${encodeURIComponent(primary)}`];
  const normalizedUuid = sanitizeIdentifier(uuid);
  if (normalizedUuid && UUID_RE.test(String(normalizedUuid))) {
    parts.push(`conversation=${encodeURIComponent(String(normalizedUuid).toLowerCase())}`);
  }
  if (parts.length === 1) return parts[0];
  return `${parts[0]}?${parts.slice(1).join('&')}`;
}

export function conversationDeepLinkFromUuid(uuid, opts = {}) {
  const link = makeConversationLink({ uuid, baseUrl: opts.baseUrl })
  if (!link) throw new Error('conversationDeepLinkFromUuid: valid UUID required')
  return link
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

export function appUrlFromRequest(req) {
  const requestUrl = new URL(req.url)
  const envBase = appUrl()
  try {
    const envUrl = new URL(envBase)
    if (LOCAL_HOSTNAMES.has(requestUrl.hostname) && requestUrl.host !== envUrl.host) {
      return `${requestUrl.protocol}//${requestUrl.host}`
    }
    return trim(envUrl.origin + envUrl.pathname)
  } catch {
    return `${requestUrl.protocol}//${requestUrl.host}`
  }
}

export function conversationIdDisplay(c) {
  return c?.uuid ?? c?.id
}
