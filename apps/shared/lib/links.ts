const trim = (s: string) => s.replace(/\/+$/, '');
export const appUrl = () => trim(process.env.APP_URL ?? 'https://app.boomnow.com');

export function conversationDeepLinkFromUuid(uuid: string): string {
  if (!uuid) throw new Error('conversationDeepLinkFromUuid: uuid is required');
  return `${appUrl()}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`;
}
