export function conversationLink(conversation) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const idOrUuid = conversation?.uuid ?? conversation?.id;
  // Link directly to the dashboard deep link to avoid relying on the `/c/:id`
  // redirect and any legacy numeric-id→UUID lookup. This ensures alert emails
  // always open the conversation, whether we have a UUID or a numeric ID.
  return `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(String(idOrUuid))}`;
}
export function conversationIdDisplay(c) {
  return c?.uuid ?? c?.id;
}
