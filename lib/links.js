export const trim = (s) => s.replace(/\/+$/,'');
export const appUrl = () => trim(process.env.APP_URL ?? 'https://app.boomnow.com');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
export function makeConversationLink({ uuid, legacyId }) {
  const base = appUrl();
  if (uuid && UUID_RE.test(String(uuid))) {
    return `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(String(uuid).toLowerCase())}`;
  }
  if (legacyId != null && /^\d+$/.test(String(legacyId))) {
    return `${base}/r/legacy/${encodeURIComponent(String(legacyId))}`;
  }
  return null;
}
export function conversationDeepLinkFromUuid(uuid) {
  const link = makeConversationLink({ uuid });
  if (!link) throw new Error('conversationDeepLinkFromUuid: valid UUID required');
  return link;
}
export function conversationIdDisplay(c) {
  return (c?.uuid ?? c?.id);
}
