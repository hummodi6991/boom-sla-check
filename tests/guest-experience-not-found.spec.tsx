import { test, expect } from '@playwright/test';
import { conversationViewState } from '../app/dashboard/guest-experience/all/GuestExperience';

test('guest experience reports not-found state when data is missing', () => {
  const state = conversationViewState({
    isLoading: false,
    error: undefined,
    hasData: false,
    initialConversationId: '999',
  });
  expect(state).toBe('not-found');
});
