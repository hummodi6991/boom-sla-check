const UNIVERSAL_PREFIX = '/go/c/';

function cleanBase(url) {
  const raw = String(url || '').trim();
  if (!raw) return 'https://app.boomnow.com';
  return raw.replace(/\/+$/, '');
}

export function buildCanonicalDeepLink(input = {}) {
  const base = cleanBase(input.appUrl);
  if (input.uuid) {
    const token = String(input.uuid).trim().toLowerCase();
    if (!token) throw new Error('identifier_required');
    return `${base}${UNIVERSAL_PREFIX}${encodeURIComponent(token)}`;
  }
  if (input.legacyId != null) {
    const token = String(input.legacyId).trim();
    if (!token) throw new Error('identifier_required');
    return `${base}${UNIVERSAL_PREFIX}${encodeURIComponent(token)}`;
  }
  if (input.slug) {
    const token = String(input.slug).trim();
    if (!token) throw new Error('identifier_required');
    return `${base}${UNIVERSAL_PREFIX}${encodeURIComponent(token)}`;
  }
  throw new Error('identifier_required');
}
