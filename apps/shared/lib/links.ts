const trim = (s: string) => s.replace(/\/+$/, '');
const stripCtlAndTrim = (s: string) =>
  String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
export const appUrl = () =>
  trim(stripCtlAndTrim(process.env.APP_URL ?? 'https://app.boomnow.com'));

export const alertLinkBase = () =>
  trim(
    stripCtlAndTrim(
      process.env.ALERT_LINK_BASE ?? process.env.APP_URL ?? 'https://app.boomnow.com',
    ),
  );

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

type ConversationLinkArgs = { uuid?: string | null; baseUrl?: string | URL }

const normalizeBaseUrl = (input?: string | URL): string => {
  const raw = input ? String(input) : appUrl()
  return trim(stripCtlAndTrim(raw))
}

export function makeConversationLink({ uuid, baseUrl }: ConversationLinkArgs) {
  const base = normalizeBaseUrl(baseUrl);
  if (uuid && UUID_RE.test(String(uuid))) {
    const normalized = String(uuid).toLowerCase();
    return `${base}/go/c/${encodeURIComponent(normalized)}`;
  }
  return null;
}

const sanitizeIdentifier = (value?: string | number | bigint | null) => {
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

export function buildResolverLink({
  identifier,
  uuid,
  baseUrl,
}: {
  identifier?: string | number | bigint | null;
  uuid?: string | null;
  baseUrl?: string | URL;
} = {}) {
  const base = normalizeBaseUrl(baseUrl ?? alertLinkBase());
  const primary = sanitizeIdentifier(identifier) ?? sanitizeIdentifier(uuid);
  if (!base || !primary) return null;
  const parts = [`${base}/boom/open/conv/${encodeURIComponent(primary)}`];
  const normalizedUuid = sanitizeIdentifier(uuid);
  if (normalizedUuid && UUID_RE.test(String(normalizedUuid))) {
    parts.push(`conversation=${encodeURIComponent(String(normalizedUuid).toLowerCase())}`);
  }
  return parts.length === 1 ? parts[0] : `${parts[0]}?${parts.slice(1).join('&')}`;
}

export function conversationDeepLinkFromUuid(
  uuid: string,
  opts?: { baseUrl?: string | URL }
): string {
  const link = makeConversationLink({ uuid, baseUrl: opts?.baseUrl })
  if (!link) throw new Error('conversationDeepLinkFromUuid: valid UUID required')
  return link
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

export function appUrlFromRequest(req: { url: string }): string {
  const requestUrl = new URL(req.url)
  const envBase = appUrl()
  try {
    const envUrl = new URL(envBase)
    if (LOCAL_HOSTNAMES.has(requestUrl.hostname) && requestUrl.host !== envUrl.host)
      return `${requestUrl.protocol}//${requestUrl.host}`
    return trim(envUrl.origin + envUrl.pathname)
  } catch {
    return `${requestUrl.protocol}//${requestUrl.host}`
  }
}
