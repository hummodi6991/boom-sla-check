const trim = (s: string) => s.replace(/\/+$/,'')
export const appUrl = () => trim(process.env.APP_URL ?? 'https://app.boomnow.com')
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

export function makeConversationLink({ uuid }:
  { uuid?: string|null }) {
  const base = appUrl()
  if (uuid && UUID_RE.test(String(uuid)))
    return `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(String(uuid).toLowerCase())}`
  return null
}

export function conversationDeepLinkFromUuid(uuid: string): string {
  const link = makeConversationLink({ uuid })
  if (!link) throw new Error('conversationDeepLinkFromUuid: valid UUID required')
  return link
}
