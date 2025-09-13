export function conversationLink(
  c?: { id?: number | string; uuid?: string } | string | null,
  base = process.env.APP_URL ?? 'https://app.boomnow.com',
) {
  const raw = typeof c === 'string' ? c : c?.uuid ?? c?.id ?? '';
  const id = String(raw ?? '').trim();
  const tmpl = process.env.CONVERSATION_LINK_TEMPLATE ?? '';
  if (id && tmpl.includes('{id}')) {
    return tmpl.replace('{id}', encodeURIComponent(id));
  }
  return id
    ? `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(id)}`
    : `${base}/dashboard/guest-experience/all`;
}

export function conversationIdDisplay(c: { uuid?: string; id?: number }) {
  return (c?.uuid ?? c?.id) as string | number;
}
