const UUID_PATH = '/dashboard/guest-experience/all';
const LEGACY_PATH = '/dashboard/guest-experience/cs';

function cleanBase(url) {
  const raw = String(url || '').trim();
  if (!raw) return 'https://app.boomnow.com';
  return raw.replace(/\/+$/, '');
}

export function buildCanonicalDeepLink(input = {}) {
  const base = cleanBase(input.appUrl);
  if (input.uuid) {
    const url = new URL(UUID_PATH, base + '/');
    url.searchParams.set('conversation', String(input.uuid));
    return url.toString();
  }
  if (input.legacyId != null) {
    const url = new URL(LEGACY_PATH, base + '/');
    url.searchParams.set('legacyId', String(input.legacyId));
    return url.toString();
  }
  throw new Error('uuid_or_legacyId_required');
}
