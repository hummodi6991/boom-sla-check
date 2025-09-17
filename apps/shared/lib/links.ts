const trim = (s: string) => s.replace(/\/+$/, '');
const stripCtlAndTrim = (s: string) =>
  String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
export const appUrl = () =>
  trim(stripCtlAndTrim(process.env.APP_URL ?? 'https://app.boomnow.com'));

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

type ConversationLinkArgs = { uuid?: string | null; baseUrl?: string | URL }

const normalizeBaseUrl = (input?: string | URL): string => {
  const raw = input ? String(input) : appUrl()
  return trim(stripCtlAndTrim(raw))
}

export function makeConversationLink({ uuid, baseUrl }: ConversationLinkArgs) {
  const base = normalizeBaseUrl(baseUrl);
  if (uuid && UUID_RE.test(String(uuid))) {
    // Deep-link to the All page instead of CS
    return `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(
      String(uuid).toLowerCase(),
    )}`;
  }
  return null;
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
