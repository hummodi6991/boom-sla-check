import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

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
    if (process.env.PERSIST_DEDUPE !== '0') {
      try {
        execSync('git config user.email "sla-bot@users.noreply.github.com"', { stdio: 'ignore' });
        execSync('git config user.name "Boom SLA Bot"', { stdio: 'ignore' });
        execSync(`git add "${STATE_PATH}"`, { stdio: 'ignore' });
        execSync('git commit -m "chore(sla): update dedupe state [skip ci]" || true', { stdio: 'ignore' });
        execSync('git push', { stdio: 'ignore' });
      } catch (e) {
        console.warn('Warn: failed to push dedupe state:', e.message);
      }
    }
  } catch (e) {
    console.warn('Warn: failed to save dedupe state:', e.message);
  }
}

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
