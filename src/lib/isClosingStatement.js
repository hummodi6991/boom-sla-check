const KEYWORDS = [
  "bye",
  "goodbye",
  "see you",
  "see ya",
  "cya",
  "talk to you later",
  "talk soon",
  "thanks, bye",
  "thanks bye",
  "thank you, bye",
  "thank you bye",
  "that's all",
  "no more questions",
  "no further questions",
  "cheers",
  "take care",
  "later",
  "laterz",
];

const CLOSING_RE = /(thanks[^a-z0-9]{0,5})?(bye|goodbye|take care|cya|see\s+ya|later|cheers)[!.\s]*$/i;

function messageBody(m) {
  return (
    m?.body ??
    m?.body_text ??
    m?.text ??
    m?.message ??
    m?.content ??
    ""
  ).toString();
}

let cachedTranslate;
async function getTranslator() {
  if (typeof globalThis.translate === "function") return globalThis.translate;
  if (cachedTranslate !== undefined) return cachedTranslate;
  try {
    const mod = await import("@vitalets/google-translate-api");
    cachedTranslate = mod.default || mod;
  } catch {
    cachedTranslate = null;
  }
  return cachedTranslate;
}

export async function isClosingStatement(message) {
  const raw = messageBody(message).toLowerCase().trim();
  if (!raw) return false;
  for (const kw of KEYWORDS) {
    if (raw.includes(kw)) return true;
  }
  if (CLOSING_RE.test(raw)) return true;

  const translator = await getTranslator();
  if (translator) {
    try {
      const res = await translator(raw, { to: "en" });
      const translated = (res?.text || "").toLowerCase();
      for (const kw of KEYWORDS) {
        if (translated.includes(kw)) return true;
      }
      if (CLOSING_RE.test(translated)) return true;
    } catch {
      /* ignore translation errors */
    }
  }

  if (process.env.USE_AI_INTENT === "1" && typeof globalThis.aiClassify === "function") {
    try {
      const { label, confidence } = await globalThis.aiClassify(raw) || {};
      if (label === "closing" && Number(confidence) >= 0.8) return true;
    } catch {
      /* ignore AI errors */
    }
  }

  return false;
}
