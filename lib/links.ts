const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function conversationLink(conversation: { id?: string | number; uuid?: string }) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const id = String(conversation?.uuid ?? conversation?.id ?? '');
  return UUID_RE.test(id)
    ? `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(id)}`
    : `${base}/c/${encodeURIComponent(id)}`;
}

export function conversationIdDisplay(c: { uuid?: string; id?: number | string }) {
  return (c?.uuid ?? c?.id) as string | number;
}
