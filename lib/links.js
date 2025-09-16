export const trim = (s) => s.replace(/\/+$/, '')

export const appUrl = () => trim(process.env.APP_URL ?? 'https://app.boomnow.com')

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

const normalizeBaseUrl = (input) => {
  if (!input) return appUrl()
  return trim(String(input))
}

export function makeConversationLink({ uuid, baseUrl }) {
  const base = normalizeBaseUrl(baseUrl)
  if (uuid && UUID_RE.test(String(uuid))) {
    return `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(String(uuid).toLowerCase())}`
  }
  return null
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
