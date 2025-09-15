'use client'
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export default function CsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const conversation = params.get('conversation');
  const legacyId = params.get('legacyId');
  const [uuid, setUuid] = useState<string | null>(
    conversation && UUID_RE.test(conversation) ? conversation.toLowerCase() : null
  );
  // NEW: allow ?conversation=<number> to behave like legacyId
  const numericConversation =
    conversation && !UUID_RE.test(conversation) && /^\d+$/.test(conversation) ? conversation : null;
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const leg = numericConversation || legacyId;
    if (!uuid && leg && /^\d+$/.test(leg)) {
      setResolving(true);
      fetch(`/api/resolve/conversation?legacyId=${encodeURIComponent(leg)}`, {
        method: 'GET',
        credentials: 'include',
      })
        .then(r => {
          if (!r.ok) {
            setNotFound(true);
            return null;
          }
          return r.json();
        })
        .then((data) => {
          const u = data?.uuid;
          if (u && UUID_RE.test(u)) {
            setUuid(u.toLowerCase());
            const sp = new URLSearchParams(window.location.search);
            sp.delete('legacyId');
            if (numericConversation) sp.delete('conversation');
            sp.set('conversation', u.toLowerCase());
            window.history.replaceState({}, '', `${window.location.pathname}?${sp.toString()}`);
          } else if (!data) {
            setNotFound(true);
          }
        })
        .catch(() => setNotFound(true))
        .finally(() => setResolving(false));
    }
  }, [legacyId, numericConversation, uuid]);

  if (notFound) {
    return <div style={{ padding: 16 }}>Conversation not found or has been deleted.</div>;
  }

  if (!uuid && (legacyId || numericConversation || resolving)) {
    return <div style={{ padding: 16 }}>Opening conversation…</div>;
  }

  return <div data-uuid={uuid ?? ''}>Conversation {uuid}</div>;
}
