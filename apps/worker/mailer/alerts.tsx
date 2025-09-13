import { tryResolveConversationUuid } from '../../server/lib/conversations';
import { conversationDeepLinkFromUuid } from '../../shared/lib/links';

export async function buildAlertEmail(inputId: string, opts?: { inlineThread?: any }) {
  const uuid = await tryResolveConversationUuid(inputId, opts);
  if (!uuid) return null;
  const url = conversationDeepLinkFromUuid(uuid);
  return `<p>Alert for conversation <a href="${url}">${url}</a></p>`;
}
