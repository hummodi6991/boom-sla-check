import { conversationDeepLinkFromUuid } from '../../shared/lib/links';
import { verifyConversationLink } from '../../shared/lib/verifyLink';
import { metrics } from '../../../lib/metrics';

export async function buildAlertEmail(
  event: { conversation_uuid?: string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const uuid = event?.conversation_uuid;
  if (!uuid) {
    deps?.logger?.warn({ event }, 'producer_violation');
    metrics.increment('alerts.skipped_producer_violation');
    return null;
  }
  const url = conversationDeepLinkFromUuid(uuid);
  const ok = await (deps?.verify ?? verifyConversationLink)(url);
  if (!ok) {
    deps?.logger?.warn({ url }, 'link_verification_failed');
    return null;
  }
  return `<p>Alert for conversation <a href="${url}">${url}</a></p>`;
}
