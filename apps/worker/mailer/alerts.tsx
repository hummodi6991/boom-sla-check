import { metrics } from '../../../lib/metrics';
import { buildAlertConversationLink } from '../../../lib/conversationLink.js';
import { appUrl } from '../../shared/lib/links';
import { signLink } from '../../../packages/linking/src/index.js';

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
  const privateJwk = process.env.LINK_PRIVATE_JWK;
  const linkBase = (process.env.ALERT_LINK_BASE || 'https://go.boomnow.com').replace(/\/+$/, '');
  const kid = process.env.LINK_KID || 'link-1';
  const iss = process.env.LINK_ISSUER || 'sla-check';
  const aud = process.env.LINK_AUDIENCE || 'boom-app';

  let primary = built.url;

  if (privateJwk) {
    try {
      const token = await signLink(
        {
          t: 'conversation',
          uuid: built.uuid ?? undefined,
          legacyId: built.legacyId ?? undefined,
          slug: event.slug ?? undefined,
          tenant: (event as any)?.tenant ?? undefined,
        },
        {
          privateJwk,
          kid,
          iss,
          aud,
          ttlSeconds: 60 * 60 * 24 * 7,
        },
      );
      primary = `${linkBase}/u/${token}`;
    } catch (err) {
      logger?.warn?.({ err }, 'failed to sign alert link token');
    }
  } else {
    logger?.warn?.('LINK_PRIVATE_JWK missing; using fallback deep link');
  }

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
