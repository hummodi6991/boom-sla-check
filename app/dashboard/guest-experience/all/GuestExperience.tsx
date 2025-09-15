'use client';

import { useEffect } from 'react';
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

export default function GuestExperience({ initialConversationId }: { initialConversationId?: string }) {
  const { data: s, isLoading, error } = useConversation(initialConversationId);

  useEffect(() => {
    if (initialConversationId && s) openDrawer(initialConversationId);
  }, [initialConversationId, s]);

  if (isLoading) return <SkeletonConversation />;
  if (error) return <InlineError message="Failed to load conversation." />;
  if (!s && initialConversationId) return null;

  // SAFETY: guard against undefined data on slower browsers
  const safe = s ?? ({ related_reservations: [] } as any);
  const related_reservations = Array.isArray(safe?.related_reservations)
    ? safe.related_reservations
    : [];
  const hasRelated = (related_reservations.length ?? 0) > 0;

  return (
    <main style={{ padding: 24 }}>
      Guest Experience {initialConversationId ? `(conversation ${initialConversationId})` : ''}
      {safe && (
        <div>
          <h2>Related Reservations</h2>
          {hasRelated ? (
            (related_reservations ?? []).map((r) => <div key={r.id}>{r.id}</div>)
          ) : (
            <div>No related reservations.</div>
          )}
        </div>
      )}
    </main>
  );
}
