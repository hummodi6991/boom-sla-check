import { test, expect } from '@playwright/test';
import { safeRelatedReservations } from '../app/dashboard/guest-experience/all/GuestExperience';

// Ensure guard returns an empty list when conversation data is missing.
test('safeRelatedReservations handles undefined conversation data', () => {
  expect(safeRelatedReservations(undefined)).toEqual([]);
  expect(safeRelatedReservations(null)).toEqual([]);
  expect(safeRelatedReservations({ related_reservations: undefined } as any)).toEqual([]);
});

// And when data exists, the helper surfaces it untouched.
test('safeRelatedReservations preserves related reservations', () => {
  const reservations = [{ id: 'r1' }, { id: 'r2' }];
  expect(safeRelatedReservations({ related_reservations: reservations } as any)).toBe(reservations);
});
