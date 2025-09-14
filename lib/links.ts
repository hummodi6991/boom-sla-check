export { appUrl, conversationDeepLinkFromUuid, conversationLink } from '../apps/shared/lib/links';

export function conversationIdDisplay(c: { uuid?: string; id?: number | string }) {
  return (c?.uuid ?? c?.id) as string | number | undefined;
}
