import { buildConversationLink } from '@/src/lib/links';

const OLD_ENV = process.env;

beforeEach(() => { jest.resetModules(); process.env = { ...OLD_ENV }; });
afterAll(() => { process.env = OLD_ENV; });

test('uses template when provided', () => {
  process.env.CONVERSATION_LINK_TEMPLATE = 'https://x/y?conversation={id}';
  const url = buildConversationLink('d5000a65-dc14-4369-a5dc-c86f6ced4ace');
  expect(url).toBe('https://x/y?conversation=d5000a65-dc14-4369-a5dc-c86f6ced4ace');
});

test('falls back to origin/dashboard when template missing', () => {
  process.env.CONVERSATION_LINK_TEMPLATE = '';
  process.env.APP_ORIGIN = 'https://app.boomnow.com';
  const url = buildConversationLink('abc 123');
  expect(url).toBe('https://app.boomnow.com/dashboard/guest-experience/all?conversation=abc%20123');
});
