import { verifyConversationLink } from '../../shared/lib/verifyLink';
import { metrics } from '../../../lib/metrics';
import { buildUniversalConversationLink } from '../../../lib/alertLink.js';

export async function buildAlertEmail(
  event: { conversation_uuid?: string; legacyId?: number | string; slug?: string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const logger = deps?.logger;
  const preferVerify = deps?.verify ?? verifyConversationLink;
  const base = (process.env.APP_URL || 'https://app.boomnow.com').replace(/\/+$/, '');

  const uuid = typeof event?.conversation_uuid === 'string' ? event.conversation_uuid : undefined;
  const hasFallback = event?.legacyId != null || typeof event?.slug === 'string';

  if (!uuid && !hasFallback) {
    logger?.warn?.({ event }, 'skip alert: missing resolvable uuid');
    metrics.increment('alerts.skipped_missing_uuid');
    return null;
  }

  let verifyFailed = false;
  const link = await buildUniversalConversationLink(
    { uuid, legacyId: event?.legacyId, slug: event?.slug },
    {
      baseUrl: base,
      verify: async (url: string) => {
        const ok = await preferVerify(url);
        if (!ok) {
          verifyFailed = true;
          logger?.warn?.({ url }, 'link_verification_failed');
        }
        return ok;
      },
      onTokenError: (err: unknown) => {
        logger?.warn?.({ uuid, err }, 'link_token_generation_failed');
      },
    }
  );

  if (!link) {
    metrics.increment('alerts.skipped_link_preflight');
    if (verifyFailed) {
      return null;
    }
    logger?.warn?.({ event }, 'skip alert: unable to build link');
    return null;
  }

  metrics.increment(
    link.kind === 'legacy' ? 'alerts.sent_with_legacy_shortlink' : 'alerts.sent_with_uuid'
  );
  return `<p>Alert for conversation <a href="${link.url}">${link.url}</a></p>`;
}
