export function conversationLink(c?: { id?: number | string; uuid?: string } | null) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const v = String(c?.uuid ?? c?.id ?? '');
  return v
    ? `${base}/r/conversation/${encodeURIComponent(v)}`
    : `${base}/dashboard/guest-experience/cs`;
}

export function conversationIdDisplay(c: { uuid?: string; id?: number }) {
  return (c?.uuid ?? c?.id) as string | number;
}
