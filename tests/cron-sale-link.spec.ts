import { test, expect } from '@playwright/test';
import { buildGuestExperienceLink } from '../lib/guestExperienceLink.js';

async function loadCronModule() {
  (globalThis as any).__CRON_TEST__ = true;
  const mod = await import('../cron.mjs');
  delete (globalThis as any).__CRON_TEST__;
  return mod as any;
}

test.describe('sale-aware cron helpers', () => {
  let cronMod: any;

  test.beforeAll(async () => {
    cronMod = await loadCronModule();
  });

  test('resolveSaleUuid extracts sale UUID from newest message metadata', async () => {
    const { resolveSaleUuid } = cronMod;
    const saleUuid = '6F80D3B2-88D3-4A9E-9CC4-0FE3E19D5C63';
    const messages = [
      { sent_at: '2024-01-01T12:00:00Z', meta: {} },
      {
        sent_at: '2024-01-02T08:30:00Z',
        payload: { saleUuid },
      },
    ];
    let fetchCalled = false;
    const fetchJson = async () => {
      fetchCalled = true;
      return {};
    };
    const result = await resolveSaleUuid('abc-123', fetchJson, { messages });
    expect(result).toBe('6f80d3b2-88d3-4a9e-9cc4-0fe3e19d5c63');
    expect(fetchCalled).toBe(false);
  });

  test('resolveSaleUuid falls back to conversation fetch when messages lack sale metadata', async () => {
    const { resolveSaleUuid } = cronMod;
    const saleUuid = '5c52c64a-4f4f-4dfb-9f5c-5b2f5a7f1d0e';
    let called = 0;
    const fetchJson = async (path: string) => {
      called += 1;
      expect(path).toBe('/api/conversations/convo-1');
      return { target: { uuid: saleUuid } };
    };
    const result = await resolveSaleUuid('convo-1', fetchJson, { messages: [] });
    expect(result).toBe(saleUuid);
    expect(called).toBe(1);
  });

  test('buildGuestExperienceLink prefers sale route with fallback to conversation filter', () => {
    const baseUrl = 'https://app.test.example';
    const conversationId = 'conv with space';
    const saleUuid = '7E64E2D9-2F0B-4E46-A4AC-2A0C1D8AF0A3';
    const saleLink = buildGuestExperienceLink({ baseUrl, saleUuid, conversationId });
    expect(saleLink).toBe(
      'https://app.test.example/dashboard/guest-experience/sales/7e64e2d9-2f0b-4e46-a4ac-2a0c1d8af0a3?via=sla&conversation=conv%20with%20space'
    );
    const fallbackLink = buildGuestExperienceLink({ baseUrl, saleUuid: null, conversationId });
    expect(fallbackLink).toBe(
      'https://app.test.example/dashboard/guest-experience/all?conversation=conv%20with%20space'
    );
  });
});
