import fs from 'fs';
import path from 'path';

const STATE_PATH = process.env.ALERT_STATE_FILE || '.github/sla_dedupe.json';

export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('Warn: failed to save dedupe state:', e.message);
  }
}

export const __kind = 'file';

export function dedupeKey(convId, lastGuestTs) {
  return `${convId}:${lastGuestTs ?? ''}`;
}

export function isDuplicateAlert(convId, lastGuestTs) {
  const key = dedupeKey(convId, lastGuestTs);
  const state = loadState();
  const entry = state[key] || state[convId];
  return { dup: Boolean(entry), state };
}

export function markAlerted(state, convId, lastGuestTs) {
  const key = dedupeKey(convId, lastGuestTs);
  state[key] = { lastUpdatedAt: lastGuestTs || null, ts: new Date().toISOString() };
  saveState(state);
}
