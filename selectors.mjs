// Not used by REST flow — kept only if you ever switch back to UI scraping.
export const MESSAGE_CONTAINER = ".message, .chat-message, .msg";
export const MESSAGE_TEXT = ".message-text, .text, .content";
export const AI_COMPONENT = ".ai-component";
export const IS_AGENT_SIDE = (classList) =>
  classList?.includes("ml-auto") || classList?.includes("mr-4");
export const IS_GUEST_SIDE = (classList) => classList?.includes("ml-4");
export const EMAIL_INPUT = "input[type='email']";
export const PASS_INPUT  = "input[type='password']";
export const LOGIN_BTN   = "button:has-text('Login'), button[type='submit']";
