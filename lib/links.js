export const appUrl = () =>
  (process.env.APP_URL ?? 'https://app.boomnow.com').replace(/\/+$/, '');

export function conversationDeepLink(uuid) {
  const base = appUrl();
  return uuid
    ? `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
    : `${base}/dashboard/guest-experience/cs`;
}

export function conversationIdDisplay(c) {
  return (c?.uuid ?? c?.id);
}
