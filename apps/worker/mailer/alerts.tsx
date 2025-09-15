import { makeConversationLink, appUrl } from '../../shared/lib/links';
import { verifyConversationLink } from '../../shared/lib/verifyLink';
import { metrics } from '../../../lib/metrics';

export async function buildAlertEmail(
  event: { conversation_uuid?: string; legacyId?: number | string },
  deps?: { logger?: any; verify?: (url: string) => Promise<boolean> }
) {
  const uuid = event?.conversation_uuid;
  // Prefer a proper UUID deep-link
  let url = makeConversationLink({ uuid });
  // Fallback: shortlink that resolves server-side
  if (!url && event?.legacyId != null && String(event.legacyId).trim() !== '') {
    const raw = String(event.legacyId).trim();
    const base = appUrl();
    const isNum = /^\d+$/.test(raw);
    url = `${base}${isNum ? '/r/legacy/' : '/r/conversation/'}${encodeURIComponent(raw)}`;
  }
  if (!url) {
    deps?.logger?.warn({ event }, 'skip alert: missing resolvable id (uuid/legacyId)');
    metrics.increment('alerts.skipped_missing_uuid');
    return null;
  }
  const ok = await (deps?.verify ?? verifyConversationLink)(url);
  if (!ok) {
    deps?.logger?.warn({ url }, 'link_verification_failed');
    metrics.increment('alerts.skipped_link_preflight');
    return null;
  }
  metrics.increment(uuid ? 'alerts.sent_with_uuid' : 'alerts.sent_with_legacy_shortlink');
  return `<p>Alert for conversation <a href="${url}">${url}</a></p>`;
}
