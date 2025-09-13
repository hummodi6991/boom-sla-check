import { ensureConversationUuid } from '../../server/lib/conversations';
import { conversationDeepLinkFromUuid } from '../../shared/lib/links';

export async function buildAlertEmail(inputId: string) {
  const uuid = await ensureConversationUuid(inputId);
  const url = conversationDeepLinkFromUuid(uuid);
  return `<p>Alert for conversation <a href="${url}">${url}</a></p>`;
}
