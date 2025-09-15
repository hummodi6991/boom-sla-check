export async function verifyConversationLink(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    if (res.status === 200) {
      // Direct deep link rendered (SPA shell)
      return true;
    }
    if (res.status !== 302) return false;
    const loc = res.headers.get('location') ?? '';
    if (loc.includes('/login') || loc.includes('/dashboard/guest-experience/cs')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
