import { test, expect } from '@playwright/test';
import { lintAlertEvent } from '../apps/shared/lib/events';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('schema lint rejects missing conversation_uuid', () => {
  expect(() => lintAlertEvent({})).toThrow(/conversation_uuid/);
});

test('schema lint accepts valid conversation_uuid', () => {
  expect(() => lintAlertEvent({ conversation_uuid: uuid })).not.toThrow();
});
