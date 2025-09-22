import { test, expect } from '@playwright/test';

const IMPORT_PATH = '../cron.mjs';

function buildGuestMessage(text: string, minsAgo: number) {
  return {
    role: 'guest',
    body: text,
    timestamp: Date.now() - minsAgo * 60000,
  };
}

async function loadEvaluator() {
  // prevent cron.mjs from executing its main block
  (globalThis as any).__CRON_TEST__ = true;
  return await import(IMPORT_PATH);
}

test('skips SLA for closing phrases', async () => {
  const { evaluateUnanswered } = await loadEvaluator();
  const now = new Date();
  const msgs = [buildGuestMessage('Thanks, bye!', 20)];
  const res = await evaluateUnanswered(msgs, now, 5);
  expect(res.ok).toBe(true);
});

test("skips SLA for 'That's all for now.'", async () => {
  const { evaluateUnanswered } = await loadEvaluator();
  const now = new Date();
  const msgs = [buildGuestMessage("That's all for now.", 20)];
  const res = await evaluateUnanswered(msgs, now, 5);
  expect(res.ok).toBe(true);
});

test('non-English closing via translate', async () => {
  (globalThis as any).translate = async () => ({ text: 'thanks bye' });
  const { evaluateUnanswered } = await loadEvaluator();
  const now = new Date();
  const msgs = [buildGuestMessage('شكراً مع السلامة', 20)];
  const res = await evaluateUnanswered(msgs, now, 5);
  expect(res.ok).toBe(true);
  delete (globalThis as any).translate;
});

test('continues SLA for non-closing question', async () => {
  const { evaluateUnanswered } = await loadEvaluator();
  const now = new Date();
  const msgs = [buildGuestMessage('Any update?', 20)];
  const res = await evaluateUnanswered(msgs, now, 5);
  expect(res.ok).toBe(false);
});

test('treats "Thanks" without goodbye as non-closing', async () => {
  const { evaluateUnanswered } = await loadEvaluator();
  const now = new Date();
  const msgs = [buildGuestMessage('Thanks', 20)];
  const res = await evaluateUnanswered(msgs, now, 5);
  expect(res.ok).toBe(false);
});

test('agent replies with senderType user end the SLA window', async () => {
  const { evaluateUnanswered } = await loadEvaluator();
  const now = new Date();
  const msgs = [
    buildGuestMessage('Hello?', 10),
    { role: 'agent', senderType: 'user', direction: 'outbound', timestamp: Date.now() - 9 * 60000 },
  ];
  const res = await evaluateUnanswered(msgs, now, 5);
  expect(res.ok).toBe(true);
  expect(res.reason).toBe('no_breach');
});

test('AI fallback honors confidence', async () => {
  const { isClosingStatement } = await import('../src/lib/isClosingStatement.js');
  process.env.USE_AI_INTENT = '1';
  (globalThis as any).aiClassify = async () => ({ label: 'closing', confidence: 0.85 });
  await expect(isClosingStatement({ body: 'random words' })).resolves.toBe(true);
  (globalThis as any).aiClassify = async () => ({ label: 'closing', confidence: 0.6 });
  await expect(isClosingStatement({ body: 'random words' })).resolves.toBe(false);
  delete (globalThis as any).aiClassify;
  delete process.env.USE_AI_INTENT;
});
