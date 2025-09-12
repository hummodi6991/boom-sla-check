import { sendAlert as baseSendAlert } from '../email.mjs';

export const sendAlert = baseSendAlert;

// Build a universal deep link for a conversation.
// Accepts an object with `uuid` or numeric `id`.
export function buildConversationLink(conversation) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const idOrUuid = conversation?.uuid ?? conversation?.id;
  if (idOrUuid === undefined || idOrUuid === null) {
    return `${base}/dashboard/guest-experience/all`;
  }
  return `${base}/c/${encodeURIComponent(String(idOrUuid))}`;
}
