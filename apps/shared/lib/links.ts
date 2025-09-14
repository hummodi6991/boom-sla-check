import { isUuid } from './uuid';
const trim = (s: string) => s.replace(/\/+$/, '');
export const appUrl = () => trim(process.env.APP_URL ?? 'https://app.boomnow.com');

export function conversationLink({ uuid, legacyId }: { uuid?: string | null; legacyId?: number | string | null }) {
  const base = appUrl();
  if (uuid && isUuid(String(uuid))) {
    return `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(String(uuid).toLowerCase())}`;
  }
  if (legacyId != null && /^\d+$/.test(String(legacyId))) {
    return `${base}/dashboard/guest-experience/cs?legacyId=${encodeURIComponent(String(legacyId))}`;
  }
  return null;
}

export function conversationDeepLinkFromUuid(uuid: string): string {
  const link = conversationLink({ uuid });
  if (!link) throw new Error('conversationDeepLinkFromUuid: valid UUID required');
  return link;
}
