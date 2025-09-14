import { makeConversationLink } from '../../shared/lib/links';
import { verifyConversationLink } from '../../shared/lib/verifyLink';
import { metrics } from '../../../lib/metrics';

export async function buildAlertEmail(
  event: { conversation_uuid?: string; legacyId?: number | string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const uuid = event?.conversation_uuid;
  const legacyId = event?.legacyId;
  const url = makeConversationLink({ uuid, legacyId });
  if (!url) {
    deps?.logger?.warn({ event }, 'skip alert: missing conversation id');
    metrics.increment('alerts.skipped_missing_uuid');
    return null;
  }
  const ok = await (deps?.verify ?? verifyConversationLink)(url);
  if (!ok) {
    deps?.logger?.warn({ url }, 'link_verification_failed');
    metrics.increment('alerts.skipped_link_preflight');
    return null;
  }
  metrics.increment(uuid ? 'alerts.sent_with_uuid' : 'alerts.sent_with_legacyId');
  return `<p>Alert for conversation <a href="${url}">${url}</a></p>`;
}
