import { test, expect } from '@playwright/test';

const IMPORT_PATH = '../check.mjs';

let evaluate: any;

test.beforeAll(async () => {
  process.env.COUNT_AI_SUGGESTION_AS_AGENT = 'false';
  (globalThis as any).__CHECK_TEST__ = true;
  const mod = await import(IMPORT_PATH);
  delete (globalThis as any).__CHECK_TEST__;
  evaluate = mod.evaluate;
});

test.afterAll(() => {
  delete process.env.COUNT_AI_SUGGESTION_AS_AGENT;
});

test.beforeEach(() => {
  (globalThis as any).translate = async () => ({ text: '' });
});

test.afterEach(() => {
  delete (globalThis as any).translate;
});

function iso(date: string) {
  return new Date(date);
}

test('Spanish closing is ignored without translation (gracias, adiós)', async () => {
  // translator stub returns empty text, so detection must come from multilingual rule
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', by: 'guest', direction: 'inbound', body: 'gracias, adiós' },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no_breach');
});

test('Diacritics normalization: "adios" (without accent) is also treated as closing', async () => {
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', by: 'guest', direction: 'inbound', body: 'gracias, adios' },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no_breach');
});

test('Thanks alone in another language does not bypass SLA ("gracias")', async () => {
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', by: 'guest', direction: 'inbound', body: 'gracias' },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('guest_unanswered');
});

test('internal notes do not satisfy the SLA window', async () => {
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', by: 'guest', direction: 'inbound', body: 'Hello there' },
    { sent_at: '2024-01-01T00:02:00Z', senderType: 'system', module: 'workflow', msg_type: 'status_change', body: 'Status updated internally' },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('guest_unanswered');
});

test('unapproved AI suggestions are ignored', async () => {
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', by: 'guest', direction: 'inbound', body: 'Hello there' },
    {
      sent_at: '2024-01-01T00:03:00Z',
      generated_by_ai: true,
      ai_status: 'draft',
      by: 'agent',
      direction: 'outbound',
      body: 'Proposed reply from AI',
    },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('guest_unanswered');
});

test('approved AI responses clear the SLA', async () => {
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', by: 'guest', direction: 'inbound', body: 'Hello there' },
    {
      sent_at: '2024-01-01T00:04:00Z',
      generated_by_ai: true,
      ai_status: 'approved',
      by: 'agent',
      direction: 'outbound',
      body: 'Approved and sent reply',
    },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no_breach');
});

test('agent responses with senderType "user" clear the SLA', async () => {
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', senderType: 'guest', direction: 'inbound', body: 'Need help' },
    { sent_at: '2024-01-01T00:02:00Z', senderType: 'user', direction: 'outbound', body: 'Sure, happy to help!' },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no_breach');
});

test('inbound messages tagged as "user" still count as guest messages', async () => {
  const now = iso('2024-01-01T00:10:00Z');
  const messages = [
    { sent_at: '2024-01-01T00:00:00Z', senderType: 'user', direction: 'inbound', body: 'Checking in again' },
  ];
  const result = await evaluate(messages, now, 5);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('guest_unanswered');
});
