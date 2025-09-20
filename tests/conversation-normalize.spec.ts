import { test, expect } from '@playwright/test';
import { normalizeConversation } from '../src/conversation';

test.describe('normalizeConversation', () => {
  test('preserves existing fields and normalizes reservations', () => {
    const raw = {
      id: 'abc',
      title: 'Sample',
      related_reservations: [
        { id: '1', foo: 'bar' },
        { id: 2 },
        { id: '   3   ' },
      ],
    };

    const normalized = normalizeConversation(raw);

    expect(normalized.id).toBe('abc');
    expect(normalized.title).toBe('Sample');
    expect(normalized.related_reservations).toEqual([
      { id: '1', foo: 'bar' },
      { id: '2' },
      { id: '3' },
    ]);
  });

  test('filters out reservations without valid identifiers', () => {
    const normalized = normalizeConversation({
      id: 'abc',
      related_reservations: [
        null,
        undefined,
        { foo: 'missing id' },
        [],
      ],
    });

    expect(normalized.related_reservations).toEqual([]);
  });

  test('defaults related reservations to an empty list when missing', () => {
    const normalized = normalizeConversation({ id: 'abc' });
    expect(normalized.related_reservations).toEqual([]);
  });

  test('uses the fallback id when the payload lacks a string id', () => {
    const normalized = normalizeConversation(
      { related_reservations: [{ id: 'xyz' }] },
      { fallbackId: 'fallback-id' }
    );

    expect(normalized.id).toBe('fallback-id');
    expect(normalized.related_reservations).toEqual([{ id: 'xyz' }]);
  });

  test('returns a safe stub when the payload is not an object', () => {
    const normalized = normalizeConversation(undefined, { fallbackId: 'stub-id' });
    expect(normalized).toEqual({ id: 'stub-id', related_reservations: [] });
  });
});
