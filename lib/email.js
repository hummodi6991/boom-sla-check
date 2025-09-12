import { sendAlert as baseSendAlert } from '../email.mjs';

export const sendAlert = baseSendAlert;

// Build a deep link to the dashboard conversation view.
// Accepts either a conversation object with a `uuid` property or a UUID string.
export function buildConversationLink(conversation) {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';
  const uuid =
    typeof conversation === 'string' ? conversation : conversation?.uuid;
  if (typeof uuid === 'string' && uuid.length > 0) {
    const convoParam = encodeURIComponent(uuid);
    return `${base}/dashboard/guest-experience/all?conversation=${convoParam}`;
  }
  return `${base}/dashboard/guest-experience/all`;
}
