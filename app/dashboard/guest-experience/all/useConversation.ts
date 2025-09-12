'use client';

import { useEffect, useState } from 'react';
import { Conversation, normalizeConversation } from '../../../../src/conversation';

export function useConversation(conversationId?: string) {
  const [data, setData] = useState<Conversation | undefined>();
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch conversation');
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(normalizeConversation(json));
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return { data, isLoading, error };
}
