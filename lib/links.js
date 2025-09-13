import { isUuid } from '../apps/shared/lib/uuid.js';
export const trim = (s) => s.replace(/\/+$/, '');
export const appUrl = () => trim(process.env.APP_URL ?? 'https://app.boomnow.com');
export function conversationDeepLinkFromUuid(uuid) {
  if (!uuid || !isUuid(uuid)) {
    throw new Error('conversationDeepLinkFromUuid: valid UUID required');
  }
  return `${appUrl()}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid.toLowerCase())}`;
}
export function conversationIdDisplay(c) {
  return (c?.uuid ?? c?.id);
}
