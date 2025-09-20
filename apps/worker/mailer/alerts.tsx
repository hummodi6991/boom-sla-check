import { metrics } from '../../../lib/metrics';
import { buildAlertConversationLink } from '../../../lib/conversationLink.js';
import { appUrl } from '../../shared/lib/links';

export async function buildAlertEmail(
  event: { conversation_uuid?: string; legacyId?: number | string; slug?: string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const logger = deps?.logger;
  const base = appUrl();
  const built = await buildAlertConversationLink(event, {
    baseUrl: base,
    verify: deps?.verify,
    strictUuid: true,
  });
  if (!built) {
    logger?.warn?.({ event }, 'skip alert: unable to build verified link');
    metrics.increment('alerts.skipped_no_uuid');
    return null;
  }
  const primary = built.url;
  const backup = built.backupUrl || built.url;
  const metric = built.minted
    ? 'alerts.sent_with_minted_link'
    : built.kind === 'token'
    ? 'alerts.sent_with_token_link'
    : built.kind === 'legacy'
    ? 'alerts.sent_with_legacy_shortlink'
    : 'alerts.sent_with_deep_link';
  metrics.increment(metric);
  return `<p>Alert for conversation <a href="${primary}">${primary}</a></p><p>Backup deep link: <a href="${backup}">${backup}</a></p>`;
}
