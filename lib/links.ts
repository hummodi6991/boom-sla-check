export function conversationLink(conversation: { uuid?: string; id?: number }) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const idOrUuid = (conversation?.uuid ?? conversation?.id);
  return `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(String(idOrUuid))}`;
}
export function conversationIdDisplay(c: { uuid?: string; id?: number }) {
  return (c?.uuid ?? c?.id) as string | number;
}
