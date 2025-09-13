export const appUrl = () =>
  (process.env.APP_URL ?? 'https://app.boomnow.com').replace(/\/+$/, '');

export function conversationDeepLink(uuid?: string) {
  const base = appUrl();
  return uuid
    ? `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
    : `${base}/dashboard/guest-experience/cs`;
}

export function conversationIdDisplay(c: { uuid?: string; id?: number | string }) {
  return (c?.uuid ?? c?.id) as string | number | undefined;
}
