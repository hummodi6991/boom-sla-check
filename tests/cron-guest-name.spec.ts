import { test, expect } from '@playwright/test';

async function loadHelpers() {
  (globalThis as any).__CRON_TEST__ = true;
  const mod = await import(`../cron.mjs?guest=${Date.now()}`);
  delete (globalThis as any).__CRON_TEST__;
  return (mod as any).__cronTest__;
}

test.describe('cron guest label helpers', () => {
  test('extractGuestName returns most recent guest name', async () => {
    const helpers = await loadHelpers();
    const messages = [
      { role: 'guest', sender: { first_name: 'Taylor', last_name: 'Example' } },
      { role: 'agent', sender: { first_name: 'Agent' } },
      { role: 'guest', sender_name: 'Jordan Q.' },
    ];
    expect(helpers.extractGuestName(messages)).toBe('Jordan Q.');
  });

  test('extractGuestName reads guest name from conversation context', async () => {
    const helpers = await loadHelpers();
    const payload = {
      data: {
        conversation: {
          participants: [
            { role: 'agent', profile: { full_name: 'Support Agent' } },
            {
              role: 'primary_guest',
              profile: { first_name: 'Alex', last_name: 'Kim' },
            },
          ],
        },
      },
    };
    expect(helpers.extractGuestName(payload)).toBe('Alex Kim');
  });

  test('extractGuestName uses guest-specific string fields in context', async () => {
    const helpers = await loadHelpers();
    const payload = {
      conversation: {
        guest_full_name: 'Morgan Price',
      },
    };
    expect(helpers.extractGuestName(payload)).toBe('Morgan Price');
  });

  test('buildGuestLabel defaults when name missing', async () => {
    const helpers = await loadHelpers();
    const messages = [
      { role: 'guest', body: 'Hello there' },
      { role: 'agent', body: 'Hi!' },
    ];
    expect(helpers.buildGuestLabel(messages)).toBe('Guest');
  });

  test('buildGuestLabel uses friendly name from raw payload', async () => {
    const helpers = await loadHelpers();
    const raw = {
      data: {
        thread: [
          { role: 'agent', sender: { full_name: 'Support' } },
          { role: 'guest', sender: { full_name: 'Jamie Rivera' } },
        ],
      },
    };
    expect(helpers.buildGuestLabel(raw)).toBe('Guest Jamie Rivera');
  });

  test('escapeHtml escapes risky characters', async () => {
    const helpers = await loadHelpers();
    expect(helpers.escapeHtml('Guest <>&"\'')).toBe('Guest &lt;&gt;&amp;&quot;&#39;');
  });
});
