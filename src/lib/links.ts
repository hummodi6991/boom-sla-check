export function buildConversationLink(id: string) {
  const tpl = process.env.CONVERSATION_LINK_TEMPLATE; // ex: ...all?conversation={id}
  if (tpl) return tpl.replace('{id}', encodeURIComponent(id));

  // Safe fallback if not set
  const origin =
    process.env.APP_ORIGIN ||
    (process.env.MESSAGES_URL ? new URL(process.env.MESSAGES_URL).origin : '') ||
    (process.env.LOGIN_URL ? new URL(process.env.LOGIN_URL).origin : '');

  return `${origin}/dashboard/guest-experience/all?conversation=${encodeURIComponent(id)}`;
}

/** Prefer a stable UUID-like field for UI links */
export function pickUiConversationId(convo: {
  uuid?: string;
  conversationId?: string;
  id?: string | number;
}) {
  return (convo.uuid || convo.conversationId || String(convo.id))!;
}
