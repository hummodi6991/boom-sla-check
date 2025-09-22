// English keywords that can appear anywhere in the message (not just at the end).
// Keep these "includes" oriented to avoid overfitting to punctuation.
const EN_INCLUDE_KEYWORDS = [
  "see you",
  "see ya",
  "talk to you later",
  "talk soon",
  "that's all",
  "that's all for now",
  "that's all for today",
  "no more questions",
  "no further questions",
];

// End-of-message tokens that indicate a closing, across several languages.
// We intentionally do NOT include bare "thanks" words here to avoid false positives.
const END_TOKENS_MULTI = [
  // English
  "bye", "goodbye", "take care", "cya", "later", "laterz", "cheers",

  // Spanish
  "adiós", "adios", "hasta luego", "hasta pronto",

  // French
  "au revoir", "à plus", "a plus",

  // Portuguese
  "tchau", "adeus",

  // Italian
  "ciao", "arrivederci",

  // German
  "tschüss", "tschuss", "auf wiedersehen",

  // Russian
  "пока", "до свидания",

  // Arabic
  "مع السلامة", "وداعا",

  // Chinese (Simplified/Traditional)
  "再见", "再見",

  // Japanese
  "さようなら",

  // Korean
  "안녕히 계세요", "안녕히 가세요",

  // Hindi
  "अलविदा",

  // Turkish
  "görüşürüz", "hoşça kal",

  // Dutch
  "tot ziens", "doei",

  // Polish
  "do widzenia",

  // Greek
  "αντίο",

  // Swedish
  "hej då", "vi ses",

  // Indonesian / Malay / Filipino
  "sampai jumpa", "selamat tinggal", "paalam",
];

// "Thanks + bye" forms in English that may appear anywhere
// (we also capture in translation path).
const EN_THANKS_BYE = [
  "thanks, bye",
  "thanks bye",
  "thank you, bye",
  "thank you bye",
];

// "That's all" in a few languages, used with includes() semantics:
const THATS_ALL_MULTI = [
  // Spanish
  "eso es todo", "es todo",
  // French
  "c'est tout",
  // Italian
  "è tutto",
  // German
  "das ist alles",
  // Russian
  "это всё", "это все",
  // Chinese
  "就这样", "就這樣",
  // Japanese
  "以上です",
  // Polish
  "to wszystko",
  // Swedish
  "det var allt",
  // Dutch
  "dat is alles",
  // Greek
  "αυτά είναι όλα",
  // Hindi
  "बस इतना ही",
  // Indonesian
  "sekian",
];

const INCLUDE_KEYWORDS = [
  ...EN_INCLUDE_KEYWORDS,
  ...EN_THANKS_BYE,
  ...THATS_ALL_MULTI,
];

// English-tail regex kept for compactness and backwards compatibility.
const CLOSING_RE_EN = /(thanks[^a-z0-9]{0,5})?(bye|goodbye|take care|cya|see\s+ya|later|cheers)[!.,\s]*$/i;

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

function stripDiacritics(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeForMatch(s) {
  const lower = String(s || "").toLowerCase().trim();
  const norm = stripDiacritics(lower).replace(/\s+/g, " ");
  return { lower, norm };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const END_TOKENS_MULTI_NORM = END_TOKENS_MULTI.map((t) =>
  stripDiacritics(t).toLowerCase().trim().replace(/\s+/g, " ")
);
const INCLUDE_KEYWORDS_NORM = INCLUDE_KEYWORDS.map((t) =>
  stripDiacritics(t).toLowerCase().trim().replace(/\s+/g, " ")
);
const END_TOKENS_MULTI_REGEX = END_TOKENS_MULTI_NORM.map((token) =>
  new RegExp(`${escapeRe(token)}[!.,，。\s]*$`, "i")
);

function endsWithAnyToken(textNorm) {
  if (!textNorm) return false;
  for (const re of END_TOKENS_MULTI_REGEX) {
    if (re.test(textNorm)) return true;
  }
  return false;
}

export async function isClosingStatement(message) {
  const raw = messageBody(message);
  const { lower, norm } = normalizeForMatch(raw);
  if (!lower) return false;

  // 1) Keyword "includes" checks (English + multilingual "that's all"/thanks+bye)
  for (const kw of INCLUDE_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  for (const kw of INCLUDE_KEYWORDS_NORM) {
    if (norm.includes(kw)) return true;
  }

  // 2) End-of-message closings (multilingual)
  if (endsWithAnyToken(norm)) return true;

  // 3) English-tail regex
  if (CLOSING_RE_EN.test(lower)) return true;

  const translator = await getTranslator();
  if (translator) {
    try {
      const res = await translator(raw, { to: "en" });
      const translated = String(res?.text || "");
      const translatedNorm = normalizeForMatch(translated);
      for (const kw of INCLUDE_KEYWORDS) {
        if (translatedNorm.lower.includes(kw)) return true;
      }
      for (const kw of INCLUDE_KEYWORDS_NORM) {
        if (translatedNorm.norm.includes(kw)) return true;
      }
      if (endsWithAnyToken(translatedNorm.norm)) return true;
      if (CLOSING_RE_EN.test(translatedNorm.lower)) return true;
    } catch {
      /* ignore translation errors */
    }
  }

  if (process.env.USE_AI_INTENT === "1" && typeof globalThis.aiClassify === "function") {
    try {
      const { label, confidence } = (await globalThis.aiClassify(raw)) || {};
      if (label === "closing" && Number(confidence) >= 0.8) return true;
    } catch {
      /* ignore AI errors */
    }
  }

  return false;
}
