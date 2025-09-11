import { sendAlert as baseSendAlert } from '../email.mjs';

export const sendAlert = baseSendAlert;

export function buildConversationLink(id) {
  const tpl =
    process.env.CONVERSATION_LINK_TEMPLATE ||
    'https://app.boomnow.com/inbox/conversations/{id}';
  if (tpl.includes('{id}')) {
    return tpl.replace('{id}', encodeURIComponent(id));
  }
  return `${tpl.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
}
