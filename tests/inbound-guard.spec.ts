import { test, expect } from '@playwright/test';
import {
  ensureVisibleInboundMessage,
  LAST_GUEST_ANY_STATE_SQL,
  LAST_VISIBLE_INBOUND_SQL,
  pickConversationIdForGuard,
} from '../lib/inboundGuard.js';
import { DbNotConfiguredError } from '../lib/postgres.js';

test('pickConversationIdForGuard selects numeric ids first', () => {
  const picked = pickConversationIdForGuard(['', 'abc', '42', '01890b14-b4cd-7eef-b13e-bb8c083bad60']);
  expect(picked).toBe('42');
});

test('pickConversationIdForGuard returns lowercase uuid', () => {
  const picked = pickConversationIdForGuard(['', '01890B14-B4CD-7EEF-B13E-BB8C083BAD60']);
  expect(picked).toBe('01890b14-b4cd-7eef-b13e-bb8c083bad60');
});

test('pickConversationIdForGuard prefers numeric anywhere in the list (uuid first)', () => {
  const picked = pickConversationIdForGuard(['01890b14-b4cd-7eef-b13e-bb8c083bad60', '42']);
  expect(picked).toBe('42');
});

test('pickConversationIdForGuard flattens nested arrays of candidates', () => {
  const picked = pickConversationIdForGuard(['', [' ', [''], ['987']], '01890B14-B4CD-7EEF-B13E-BB8C083BAD60']);
  expect(picked).toBe('987');
});

test('ensureVisibleInboundMessage skips when id missing', async () => {
  const calls: any[] = [];
  const result = await ensureVisibleInboundMessage('', {
    logger: { warn: () => calls.push('warn') },
    query: async () => {
      throw new Error('should not query');
    },
  });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('missing_id');
  expect(calls).toHaveLength(0);
});

test('ensureVisibleInboundMessage reports skip when no inbound message found', async () => {
  const logs: any[] = [];
  const result = await ensureVisibleInboundMessage('123', {
    logger: { warn: (...args: any[]) => logs.push(args) },
    query: async (sql: string, params: any[]) => {
      expect([LAST_VISIBLE_INBOUND_SQL, LAST_GUEST_ANY_STATE_SQL]).toContain(sql);
      expect(params).toEqual(['123']);
      return null;
    },
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('no_visible_inbound');
  expect(logs).toHaveLength(1);
  expect(logs[0][0]).toBe('Skip SLA email: no visible inbound message');
  expect(logs[0][1]).toEqual(expect.objectContaining({ conversationId: '123' }));
});

test('ensureVisibleInboundMessage resolves when inbound message exists', async () => {
  const logs: any[] = [];
  const result = await ensureVisibleInboundMessage('456', {
    logger: { warn: (...args: any[]) => logs.push(args) },
    query: async () => ({ id: 1, created_at: new Date().toISOString() }),
  });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('found');
  expect(result.inbound).toEqual(expect.objectContaining({ id: 1 }));
  expect(logs).toHaveLength(0);
});

test('ensureVisibleInboundMessage short-circuits when in-memory messages show inbound guest', async () => {
  const messages = [{ direction: 'inbound', by: 'guest', sent_at: new Date().toISOString() }];
  const result = await ensureVisibleInboundMessage('123', {
    messages,
    query: async () => { throw new Error('should not be called'); },
  });
  expect(result.ok).toBe(true);
  expect(['found_in_memory', 'found', 'found_any_state']).toContain(result.reason);
});

test('ensureVisibleInboundMessage falls back to relaxed SQL when strict query returns nothing', async () => {
  const calls: string[] = [];
  const result = await ensureVisibleInboundMessage('789', {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === LAST_VISIBLE_INBOUND_SQL) return null; // strict misses
      if (sql === LAST_GUEST_ANY_STATE_SQL) return { id: 99, created_at: new Date().toISOString() };
      throw new Error('unexpected SQL');
    },
  });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('found_any_state');
  expect(calls).toEqual([LAST_VISIBLE_INBOUND_SQL, LAST_GUEST_ANY_STATE_SQL]);
});

test('ensureVisibleInboundMessage tolerates db not configured errors', async () => {
  const result = await ensureVisibleInboundMessage('789', {
    query: async () => {
      throw new DbNotConfiguredError();
    },
  });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('db_not_configured');
});

test('ensureVisibleInboundMessage logs and continues on unexpected errors', async () => {
  const logs: any[] = [];
  const result = await ensureVisibleInboundMessage('101', {
    logger: { warn: (...args: any[]) => logs.push(args) },
    query: async () => {
      const err: any = new Error('boom');
      err.code = 'SOMETHING_ELSE';
      throw err;
    },
  });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('error');
  expect(result.error).toBeTruthy();
  expect(logs).toHaveLength(1);
  expect(logs[0][1]).toEqual(expect.objectContaining({ conversationId: '101' }));
});

