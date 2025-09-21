import * as fileBased from '../dedupe.mjs';

const REDIS_URL = String(process.env.REDIS_URL || '').trim();

let impl = fileBased;
let kind = fileBased.__kind || 'file';

if (REDIS_URL) {
  try {
    const redisModule = await import('./dedupe-redis.mjs');
    impl = redisModule;
    kind = redisModule.__kind || 'redis';
  } catch (error) {
    const message = error?.message || String(error);
    console.warn('Warn: failed to initialise Redis dedupe, falling back to file store:', message);
  }
}

export function dedupeKey(...args) {
  return impl.dedupeKey(...args);
}

export function isDuplicateAlert(...args) {
  return impl.isDuplicateAlert(...args);
}

export function markAlerted(...args) {
  return impl.markAlerted(...args);
}

export function __getImplementationKind() {
  return kind;
}

export function __getImplementation() {
  return impl;
}
