'use client'
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export default function CsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const conversation = params.get('conversation');
  const legacyId = params.get('legacyId');
  const [uuid, setUuid] = useState<string | null>(conversation && UUID_RE.test(conversation) ? conversation.toLowerCase() : null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!uuid && legacyId && /^\d+$/.test(legacyId)) {
      setResolving(true);
      fetch(`/api/resolve/conversation?legacyId=${encodeURIComponent(legacyId)}`, { method: 'GET', credentials: 'include' })
        .then(r => r.ok ? r.json() : Promise.reject(r))
        .then(({ uuid: u }) => {
          if (u && UUID_RE.test(u)) {
            setUuid(u.toLowerCase());
            const sp = new URLSearchParams(window.location.search);
            sp.delete('legacyId');
            sp.set('conversation', u.toLowerCase());
            window.history.replaceState({}, '', `${window.location.pathname}?${sp.toString()}`);
          }
        })
        .catch(() => {})
        .finally(() => setResolving(false));
    }
  }, [legacyId, uuid]);

  if (!uuid && (legacyId || resolving)) {
    return <div style={{ padding: 16 }}>Opening conversation…</div>;
  }

  return <div data-uuid={uuid ?? ''}>Conversation {uuid}</div>;
}
