export type Conversation = {
  id?: string | number;
  uuid?: string;
  conversationId?: string;
  lastActivityAt?: string; // ISO string
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Preferred: ask API for the global newest 50 directly */
export async function getTop50PlatformWide(): Promise<Conversation[]> {
  if (process.env.PLATFORM_TOP50_URL) {
    return jsonFetch<Conversation[]>(process.env.PLATFORM_TOP50_URL);
  }
  const base = process.env.CONVERSATIONS_URL!;
  const url = new URL(base);
  url.searchParams.set('limit', '50');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'lastActivity');
  return jsonFetch<Conversation[]>(url.toString());
}

/** Fallback: fetch a window, then sort locally and slice top 50 */
export async function getNewest50FromFetchedSet(): Promise<Conversation[]> {
  const base = process.env.CONVERSATIONS_URL!;
  const data = await jsonFetch<Conversation[]>(base);
  return data
    .sort(
      (a, b) =>
        new Date(b.lastActivityAt ?? 0).getTime() -
        new Date(a.lastActivityAt ?? 0).getTime()
    )
    .slice(0, 50);
}

/** Final getter used by the cron */
export async function getNewest50(): Promise<Conversation[]> {
  try {
    return await getTop50PlatformWide();
  } catch (err) {
    console.warn('Top50 platform-wide failed; falling back to local sort:', err);
    return getNewest50FromFetchedSet();
  }
}
