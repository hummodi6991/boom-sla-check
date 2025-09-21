function tryDecode(value) {
  if (typeof value !== 'string') return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function unwrapUrl(urlStr) {
  if (!urlStr) return urlStr;
  try {
    const input = String(urlStr);
    const primary = new URL(input);
    const paramNames = ['u', 'url', 'q', 'target', 'redirect', 'link'];
    for (const key of paramNames) {
      const val = primary.searchParams.get(key);
      if (!val) continue;
      if (/^https?:/i.test(val)) return val;
      const decoded = tryDecode(val);
      if (decoded && /^https?:/i.test(decoded)) return decoded;
    }
    const segments = primary.pathname.split('/').filter(Boolean);
    for (const segment of segments) {
      if (/^https?:/i.test(segment)) return segment;
      const decoded = tryDecode(segment);
      if (decoded && /^https?:/i.test(decoded)) return decoded;
    }
  } catch {
    // ignore parse errors and fall through
  }
  return urlStr;
}
