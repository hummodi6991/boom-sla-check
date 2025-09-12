const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function conversationLink(conversation) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const idOrUuid = String(conversation?.uuid ?? conversation?.id ?? '');
  if (!idOrUuid)
    return `${base}/dashboard/guest-experience/all`;
  return UUID_RE.test(idOrUuid)
    ? `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(idOrUuid)}`
    : `${base}/c/${encodeURIComponent(idOrUuid)}`;
}
export function conversationIdDisplay(c) {
  return c?.uuid ?? c?.id;
}
