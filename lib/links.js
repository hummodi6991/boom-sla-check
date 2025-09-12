export function conversationLink(c) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const v = String(c?.uuid ?? c?.id ?? '');
  return v
    ? `${base}/r/conversation/${encodeURIComponent(v)}`
    : `${base}/dashboard/guest-experience/all`;
}
export function conversationIdDisplay(c) {
  return c?.uuid ?? c?.id;
}
