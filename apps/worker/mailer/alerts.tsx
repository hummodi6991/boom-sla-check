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
  const configuredLinkBase = process.env.ALERT_LINK_BASE;
  const linkBase = (configuredLinkBase || 'https://go.boomnow.com').replace(/\/+$/, '');
  const kid = process.env.LINK_KID || 'link-1';
  const iss = process.env.LINK_ISSUER || 'sla-check';
  const aud = process.env.LINK_AUDIENCE || 'boom-app';

  let primary = built.url;

  const requireSignedLinks = process.env.REQUIRE_SIGNED_ALERT_LINKS === '1';
  if (requireSignedLinks && (!privateJwk || !configuredLinkBase)) {
    metrics.increment('alerts.sent_with_unsigned_blocked');
    throw new Error(
      'Signed alert links required in production; configure LINK_PRIVATE_JWK/ALERT_LINK_BASE.'
    );
  }

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
      if (requireSignedLinks) {
        metrics.increment('alerts.sent_with_unsigned_blocked');
        throw err;
      }
    }
  } else {
    logger?.warn?.('LINK_PRIVATE_JWK missing; using fallback deep link');
  }

  let backupId = built.uuid || null;
  if (!backupId && built.minted && typeof built.url === 'string') {
    try {
      const parsed = new URL(built.url);
      const pathMatch = parsed.pathname.match(/\/go\/c\/([^/]+)/);
      if (pathMatch?.[1]) {
        backupId = decodeURIComponent(pathMatch[1]);
      } else {
        const queryCandidate = parsed.searchParams.get('conversation');
        if (queryCandidate) backupId = queryCandidate;
      }
    } catch {
      const fallbackMatch = built.url.match(/[?&]conversation=([^&#]+)/i);
      if (fallbackMatch?.[1]) {
        try {
          backupId = decodeURIComponent(fallbackMatch[1]);
        } catch {
          backupId = fallbackMatch[1];
        }
      }
    }
  }
  if (!backupId) {
    backupId = built.legacyId || built.slug || '';
  }
  const backupBase = process.env.ALERT_LINK_BASE?.replace(/\/+$/, '') || linkBase;
  const backup = `${backupBase}/go/c/${encodeURIComponent(backupId)}`;
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
