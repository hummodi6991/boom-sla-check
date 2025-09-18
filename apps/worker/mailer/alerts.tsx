import { metrics } from '../../../lib/metrics';
import { buildUniversalConversationLink } from '../../../lib/alertLink';
import { appUrl } from '../../shared/lib/links';

export async function buildAlertEmail(
  event: { conversation_uuid?: string; legacyId?: number | string; slug?: string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const logger = deps?.logger;
  const base = appUrl();
  const built = await buildUniversalConversationLink(
    { uuid: event?.conversation_uuid, legacyId: event?.legacyId, slug: event?.slug },
    { baseUrl: base, verify: deps?.verify, strictUuid: true }
  );
  if (!built) {
    logger?.warn?.({ event }, 'skip alert: unable to build verified link');
    metrics.increment('alerts.skipped_no_uuid');
    return null;
  }
  metrics.increment(
    built.kind === 'legacy' ? 'alerts.sent_with_legacy_shortlink' : 'alerts.sent_with_uuid'
  );
  return `<p>Alert for conversation <a href="${built.url}">${built.url}</a></p>`;
}
