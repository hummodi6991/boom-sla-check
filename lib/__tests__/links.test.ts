import { conversationLink } from '../links';

describe('conversationLink', () => {
  const base = process.env.APP_URL ?? 'https://app.boomnow.com';

  it('emits dashboard deep link when given a UUID', () => {
    const uuid = '6a79ee22-5763-4e24-8b43-942840060b61';
    expect(conversationLink({ uuid })).toBe(
      `${base}/dashboard/guest-experience/all?conversation=${uuid}`
    );
  });

  it('falls back to /c/:id when ID is numeric', () => {
    expect(conversationLink({ id: 997715 })).toBe(`${base}/c/997715`);
  });
});
