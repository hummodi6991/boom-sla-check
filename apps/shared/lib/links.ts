const trim = (s: string) => s.replace(/\/+$/, '');
export const appUrl = () => trim(process.env.APP_URL ?? 'https://app.boomnow.com');

export function conversationDeepLinkFromUuid(uuid: string): string {
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
    throw new Error('conversationDeepLinkFromUuid: valid UUID required');
  }
  return `${appUrl()}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid.toLowerCase())}`;
}
