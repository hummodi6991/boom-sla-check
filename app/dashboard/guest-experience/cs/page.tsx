'use client'
import { useEffect, useRef, useState } from 'react';
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
  // Treat ?conversation=<number> as a legacy id and auto-resolve it
  const numericConversation =
    conversation && !UUID_RE.test(conversation) && /^\d+$/.test(conversation) ? conversation : null;
  const numericLegacyId = legacyId && /^\d+$/.test(legacyId) ? legacyId : null;
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const previousParams = useRef<{ conversation: string | null; legacyId: string | null }>({
    conversation,
    legacyId,
  });

  useEffect(() => {
    const prev = previousParams.current;
    if (prev.conversation !== conversation || prev.legacyId !== legacyId) {
      setNotFound(false);
      previousParams.current = { conversation, legacyId };
    }
  }, [conversation, legacyId]);

  useEffect(() => {
    if (conversation && UUID_RE.test(conversation)) {
      const normalized = conversation.toLowerCase();
      setUuid((current) => (current === normalized ? current : normalized));
    } else {
      setUuid((current) => (current === null ? current : null));
    }
  }, [conversation]);

  useEffect(() => {
    const leg = numericConversation || numericLegacyId;
    if (!uuid && leg) {
      setResolving(true);
      setNotFound(false);
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
            const normalized = u.toLowerCase();
            setUuid(normalized);
            const sp = new URLSearchParams(window.location.search);
            sp.delete('legacyId');
            if (numericConversation) sp.delete('conversation');
            sp.set('conversation', normalized);
            const nextQuery = sp.toString();
            const nextUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
            router.replace(nextUrl, { scroll: false });
            setNotFound(false);
          } else {
            setNotFound(true);
            setUuid(null);
          }
        })
        .catch(() => {
          setNotFound(true);
          setUuid(null);
        })
        .finally(() => setResolving(false));
    }
  }, [numericLegacyId, numericConversation, router, uuid]);

  useEffect(() => {
    if (uuid) {
      const url = `/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`;
      router.replace(url, { scroll: false });
    }
  }, [uuid, router]);

  if (notFound) {
    return <div style={{ padding: 16 }}>Conversation not found or has been deleted.</div>;
  }

  return (
    <div style={{ padding: 16 }}>
      {resolving || legacyId || numericConversation ? 'Opening conversation…' : 'Conversation'}
    </div>
  );
}
