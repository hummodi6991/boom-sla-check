export function conversationLink(conversation) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const idOrUuid = String(conversation?.uuid ?? conversation?.id ?? '');
  if (!idOrUuid) return `${base}/dashboard/guest-experience/all`;
  // Path-based so trackers can't drop query strings.
  return `${base}/r/conversation/${encodeURIComponent(idOrUuid)}`;
}
export function conversationIdDisplay(c) {
  return c?.uuid ?? c?.id;
}
