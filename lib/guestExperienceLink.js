import { appUrl } from './links.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export function buildGuestExperienceLink({ baseUrl, saleUuid, conversationId }) {
  const base = (baseUrl || appUrl()).replace(/\/+$/, '');
  const convId = conversationId != null ? String(conversationId) : '';
  const encodedConv = encodeURIComponent(convId);
  if (saleUuid && UUID_RE.test(String(saleUuid))) {
    const normalized = String(saleUuid).toLowerCase();
    return `${base}/dashboard/guest-experience/sales/${normalized}?via=sla&conversation=${encodedConv}`;
  }
  return `${base}/dashboard/guest-experience/all?conversation=${encodedConv}`;
}
