// Leftover UI-scraping selectors (not used by REST checker).
// Keeping this file in case you later switch back to a headful scraper.

export const MESSAGE_CONTAINER = ".message, .chat-message, .msg";
export const MESSAGE_TEXT = ".message-text, .text, .content";

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
