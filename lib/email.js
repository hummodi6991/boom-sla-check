import { sendAlert as baseSendAlert } from '../email.mjs';

export const sendAlert = baseSendAlert;

export function buildConversationLink(id) {
  const tpl = process.env.CONVERSATION_LINK_TEMPLATE;
  if (tpl && tpl.includes('{id}')) {
    return tpl.replace('{id}', encodeURIComponent(id));
  }
  const origin = process.env.APP_ORIGIN
    || (process.env.MESSAGES_URL ? new URL(process.env.MESSAGES_URL).origin : null)
    || (process.env.LOGIN_URL ? new URL(process.env.LOGIN_URL).origin : '');
  return `${origin}/inbox/conversations/${encodeURIComponent(id)}`;
}
