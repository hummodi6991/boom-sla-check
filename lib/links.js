export function conversationLink(conversation) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const idOrUuid = conversation?.uuid ?? conversation?.id;
  return `${base}/c/${encodeURIComponent(String(idOrUuid))}`;
}
export function conversationIdDisplay(c) {
  return c?.uuid ?? c?.id;
}
