export async function verifyConversationLink(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    if (res.status === 200) {
      // Direct deep link rendered (SPA shell)
      return true;
    }
    // Accept any 3xx; verify Location header points to our login or deep link path
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? '';
      return /\/login\b|\/dashboard\/guest-experience\/cs\b/.test(loc);
    }
    return false;
  } catch {
    return false;
  }
}
