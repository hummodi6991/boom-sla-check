import { resolveConversation } from './resolve.js';
import { mintUuidFromRaw } from './mint.js';
import { isUuid as isCanonicalUuid } from './utils.js';
import { Policy, ConsecutiveBreaker } from 'cockatiel';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('boom-sla-check');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const DEFAULT_BASE_URL = 'https://app.boomnow.com';

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const breakerPolicy = Policy.handleAll().circuitBreaker(10_000, new ConsecutiveBreaker(5));

const hedgeDelayMs = () => Math.max(toInt(process.env.HEDGE_MS, 120), 0);
const resolverAttempts = () => Math.max(toInt(process.env.RESOLVER_MAX_ATTEMPTS, 3), 1);

const buildRetryPolicy = () => {
  const attempts = resolverAttempts();
  return Policy.handleAll()
    .retry()
    .attempts(attempts)
    .exponential({ initialDelay: 80, maxDelay: 1_000, maxAttempts: attempts });
};

const buildResolverPolicy = () => Policy.wrap(buildRetryPolicy(), breakerPolicy);

const cleanBase = (value) =>
  String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .replace(/\/+$/, '');

function getInternalConfig() {
  const secret = String(process.env.RESOLVE_SECRET || '').trim();
  if (!secret) return null;
  const baseCandidate =
    process.env.RESOLVE_BASE_URL || process.env.APP_URL || DEFAULT_BASE_URL;
  const base = cleanBase(baseCandidate);
  if (!base) return null;
  return { base, secret };
}

async function fetchInternalUuid(raw) {
  const config = getInternalConfig();
  if (!config) return null;
  const url = `${config.base}/api/resolve/conversation?id=${encodeURIComponent(raw)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-resolve-secret': config.secret },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) {
      const error = new Error(`internal_resolver_${res.status}`);
      error.status = res.status;
      throw error;
    }
    if (res.status === 401 || res.status === 403) {
      const error = new Error(`internal_resolver_auth_${res.status}`);
      error.status = res.status;
      throw error;
    }
    return null;
  }
  const data = await res.json().catch(() => null);
  const uuid = typeof data?.uuid === 'string' ? data.uuid.trim() : '';
  return UUID_RE.test(uuid) ? uuid.toLowerCase() : null;
}

function buildResolveInput(raw, opts = {}, allowMintFallback = false) {
  const input = { allowMintFallback };
  if (UUID_RE.test(raw)) {
    input.uuid = raw;
  } else if (/^\d+$/.test(raw)) {
    input.legacyId = raw;
  } else {
    input.slug = raw;
  }
  if (opts.inlineThread) input.inlineThread = opts.inlineThread;
  if (typeof opts.fetchFirstMessage === 'function') {
    input.fetchFirstMessage = opts.fetchFirstMessage;
  }
  if (opts.skipRedirectProbe != null) {
    input.skipRedirectProbe = opts.skipRedirectProbe;
  }
  if (typeof opts.onDebug === 'function') input.onDebug = opts.onDebug;
  return input;
}

function createFallbackController(resolver, delayMs, span) {
  let timer = null;
  let triggered = false;
  let resolveTrigger;

  const ready = new Promise((resolve) => {
    resolveTrigger = () => {
      if (triggered) return;
      triggered = true;
      span?.addEvent?.('resolver.fallback.trigger');
      resolve();
    };
  });

  const promise = ready
    .then(async () => {
      span?.addEvent?.('resolver.fallback.start');
      return resolver();
    })
    .catch(() => null)
    .then((result) => {
      if (result?.value) {
        span?.addEvent?.('resolver.fallback.success');
      } else {
        span?.addEvent?.('resolver.fallback.miss');
      }
      return result;
    });

  if (delayMs <= 0) {
    resolveTrigger();
  } else {
    timer = setTimeout(() => {
      timer = null;
      resolveTrigger();
    }, delayMs);
  }

  return {
    promise,
    trigger() {
      resolveTrigger();
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isTriggered() {
      return triggered;
    },
  };
}

async function resolveViaProbes(raw, opts) {
  const input = buildResolveInput(raw, opts, false);
  const resolved = await resolveConversation(input);
  const uuid = resolved?.uuid;
  return typeof uuid === 'string' && UUID_RE.test(uuid) ? uuid.toLowerCase() : null;
}

async function resolveConversationUuidHedgedInternal(raw, opts, span) {
  if (UUID_RE.test(raw)) {
    return { uuid: raw.toLowerCase(), source: 'direct' };
  }

  const allowMintFallback = opts.allowMintFallback !== false;
  const config = getInternalConfig();
  const internalAvailable = Boolean(config);

  const fallbackController = createFallbackController(
    async () => {
      try {
        const uuid = await resolveViaProbes(raw, opts);
        return uuid ? { source: 'fallback', value: uuid } : null;
      } catch {
        return null;
      }
    },
    internalAvailable ? hedgeDelayMs() : 0,
    span,
  );

  const fallbackPromise = fallbackController.promise.then((result) => {
    fallbackController.cancel();
    return result;
  });

  let internalPromise = Promise.resolve(null);
  if (internalAvailable) {
    internalPromise = buildResolverPolicy()
      .execute(() => fetchInternalUuid(raw))
      .then((uuid) => {
        if (uuid && UUID_RE.test(uuid)) {
          span?.addEvent?.('resolver.internal.success');
          return { source: 'internal', value: uuid.toLowerCase() };
        }
        span?.addEvent?.('resolver.internal.miss');
        return null;
      })
      .catch((error) => {
        span?.addEvent?.('resolver.internal.error', { message: error?.message || String(error) });
        fallbackController.trigger();
        return null;
      });
  }

  const raceCandidates = internalAvailable
    ? [internalPromise, fallbackPromise]
    : [fallbackPromise];
  const firstResult = await Promise.race(raceCandidates);

  if (firstResult?.value) {
    return { uuid: firstResult.value, source: firstResult.source };
  }

  const internalResult = await internalPromise;
  if (!fallbackController.isTriggered()) fallbackController.trigger();
  const fallbackResult = await fallbackPromise;

  if (internalResult?.value) {
    return { uuid: internalResult.value, source: internalResult.source };
  }
  if (fallbackResult?.value) {
    return { uuid: fallbackResult.value, source: fallbackResult.source };
  }

  if (allowMintFallback) {
    try {
      const minted = mintUuidFromRaw(raw);
      if (minted && isCanonicalUuid(minted)) {
        span?.addEvent?.('resolver.minted');
        return { uuid: minted.toLowerCase(), source: 'minted' };
      }
    } catch (error) {
      span?.addEvent?.('resolver.minted.error', { message: error?.message || String(error) });
      return { uuid: null, source: 'minted' };
    }
  }

  return { uuid: null, source: 'none' };
}

export async function resolveConversationUuidHedged(idOrSlug, opts = {}) {
  return tracer.startActiveSpan('resolveConversationUuidHedged', async (span) => {
    const raw = String(idOrSlug ?? '').trim();
    span.setAttribute('conversation.candidate', raw);
    try {
      if (!raw) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'empty candidate' });
        return null;
      }

      const { uuid, source } = await resolveConversationUuidHedgedInternal(raw, opts, span);
      span.setAttribute('conversation.resolve_source', source);
      if (uuid) {
        span.setAttribute('conversation.uuid', uuid);
      }
      return uuid;
    } catch (error) {
      span.recordException?.(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message || String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function resolveConversationUuid(idOrSlug, opts = {}) {
  return resolveConversationUuidHedged(idOrSlug, opts);
}

export const __test__ = {
  breakerPolicy,
  buildRetryPolicy,
  buildResolverPolicy,
  getInternalConfig,
  hedgeDelayMs,
};
