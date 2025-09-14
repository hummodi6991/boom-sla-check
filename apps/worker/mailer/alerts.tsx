import { makeConversationLink } from '../../shared/lib/links';
import { verifyConversationLink } from '../../shared/lib/verifyLink';
import { metrics } from '../../../lib/metrics';

export async function buildAlertEmail(
  event: { conversation_uuid?: string; legacyId?: number | string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const uuid = event?.conversation_uuid;
  if (!uuid) {
    deps?.logger?.warn(
      { event },
      'skip alert: missing conversation_uuid; include a UUID per docs/conversation-uuid-migration.md'
    );
    metrics.increment('alerts.skipped_missing_uuid');
    return null;
  }
  const url = makeConversationLink({ uuid });
  if (!url) {
    deps?.logger?.warn({ event }, 'skip alert: invalid conversation_uuid');
    metrics.increment('alerts.skipped_missing_uuid');
    return null;
  }
  const ok = await (deps?.verify ?? verifyConversationLink)(url);
  if (!ok) {
    deps?.logger?.warn({ url }, 'link_verification_failed');
    metrics.increment('alerts.skipped_link_preflight');
    return null;
  }
  metrics.increment('alerts.sent_with_uuid');
  return `<p>Alert for conversation <a href="${url}">${url}</a></p>`;
}
