'use client';

import { useEffect, useMemo } from 'react';
import { normalizeConversation } from '../../../../src/conversation';
import type { Conversation } from '../../../../src/conversation';
import { useConversation } from './useConversation';

function SkeletonConversation() {
  return <div data-testid="skeleton">Loading conversation…</div>;
}

function InlineError({ message }: { message: string }) {
  return <div role="alert">{message}</div>;
}

function openDrawer(id: string) {
  // placeholder for drawer opening logic
  console.log('open drawer', id);
}

export type ConversationViewState = 'loading' | 'error' | 'not-found' | 'ready';

export function conversationViewState(args: {
  isLoading: boolean;
  error?: Error | undefined;
  hasData: boolean;
  initialConversationId?: string;
}): ConversationViewState {
  if (args.isLoading) return 'loading';
  if (args.error) return 'error';
  if (!args.hasData && args.initialConversationId) return 'not-found';
  return 'ready';
}

export function safeRelatedReservations(conversation?: Conversation | null) {
  const related = conversation?.related_reservations;
  return Array.isArray(related) ? related : [];
}

export default function GuestExperience({ initialConversationId }: { initialConversationId?: string }) {
  const { data, isLoading, error } = useConversation(initialConversationId);

  const safe = useMemo(
    () => normalizeConversation(data ?? undefined, { fallbackId: initialConversationId }),
    [data, initialConversationId]
  );

  const state = conversationViewState({
    isLoading,
    error,
    hasData: Boolean(data),
    initialConversationId,
  });

  useEffect(() => {
    if (!initialConversationId) return;
    if (!data) return;
    if (!safe?.id) return;
    openDrawer(safe.id);
  }, [initialConversationId, data, safe?.id]);

  if (state === 'loading') return <SkeletonConversation />;
  if (state === 'error') return <InlineError message="Failed to load conversation." />;

  if (state === 'not-found') {
    return (
      <main style={{ padding: 24 }}>
        <InlineError message="Conversation not found or has been deleted." />
      </main>
    );
  }

  const relatedReservations = safeRelatedReservations(safe);
  const hasRelated = relatedReservations.length > 0;

  return (
    <main style={{ padding: 24 }}>
      Guest Experience {initialConversationId ? `(conversation ${initialConversationId})` : ''}
      <div>
        <h2>Related Reservations</h2>
        {hasRelated ? (
          relatedReservations.map((r) => <div key={r.id}>{r.id}</div>)
        ) : (
          <div>No related reservations.</div>
        )}
      </div>
    </main>
  );
}
