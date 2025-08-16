// All selectors are derived from your snapshots.
// Real chat message card (guest or agent), not AI suggestion:
export const CARD = "div.v-card.v-sheet.theme--light.elevation-0";

// Inside a real card, the bubble text area:
export const MSG_BOX = ".msg-box";

// Timestamp line inside a real card:
export const TIME_ROW = ".d-flex.justify-end.align-center.text-caption.grey--text.mt-1, .d-flex.align-center.text-caption.grey--text.mt-1";

// AI suggestion container we MUST ignore:
export const AI_COMPONENT = ".ai-component";

// Heuristic to detect agent-side (right) vs guest-side (left):
export const IS_AGENT_SIDE = (classList) =>
  classList?.includes("ml-auto") || classList?.includes("mr-4");

export const IS_GUEST_SIDE = (classList) =>
  classList?.includes("ml-4");

// Login page selectors:
export const EMAIL_INPUT = "input[type='email']";
export const PASS_INPUT  = "input[type='password']";
export const LOGIN_BTN   = "button:has-text('Login'), button[type='submit']";
