export async function verifyConversationLink(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    if (res.status === 200) {
      // Only accept a rendered deep link when it matches the canonical path
      const u = new URL(url);
      return /\/dashboard\/guest-experience\/all\b/.test(u.pathname);
    }
    // Accept any 3xx; verify Location header points to our login or deep link path
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? '';
      if (/\/login\b/.test(loc)) return true;
      if (/\/go\/c\//.test(loc)) return true;
      return /\/dashboard\/guest-experience\/all\b/.test(loc);
    }
    return false;
  } catch {
    return false;
  }
}
