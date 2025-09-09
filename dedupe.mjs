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

export function isDuplicateAlert(id, updatedAt) {
  const state = loadState();
  const entry = state[id];
  if (!entry) return { dup: false, state };
  if (!updatedAt) return { dup: true, state };
  const prev = entry.lastUpdatedAt ? new Date(entry.lastUpdatedAt).getTime() : 0;
  const curr = new Date(updatedAt).getTime();
  return { dup: prev >= curr, state };
}

export function markAlerted(state, id, updatedAt) {
  state[id] = { lastUpdatedAt: updatedAt || null, ts: new Date().toISOString() };
  saveState(state);
}
