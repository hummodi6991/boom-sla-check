'use client';

import { useEffect, useState } from 'react';
import GuestExperience from './GuestExperience';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Props = {
  initialConversationId?: string;
};

export default function ConversationResolver({
  initialConversationId,
}: Props) {
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [resolverError, setResolverError] = useState(false);

  useEffect(() => {
    if (!initialConversationId) {
      setConversationId(undefined);
      setResolverError(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function resolve() {
      try {
        setResolverError(false);
        const raw = String(initialConversationId);
        const res = await fetch(
          `/api/resolve/conversation?raw=${encodeURIComponent(raw)}`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          throw new Error(`resolve_failed:${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;

        if (data?.uuid) {
          const normalized = String(data.uuid).toLowerCase();
          setConversationId(normalized);
          if (
            normalized &&
            typeof window !== 'undefined' &&
            window.history &&
            normalized !== raw.toLowerCase()
          ) {
            try {
              const currentUrl = new URL(window.location.href);
              currentUrl.searchParams.set('conversation', normalized);
              window.history.replaceState(
                window.history.state,
                '',
                `${currentUrl.pathname}?${currentUrl.search}`
              );
            } catch {
              // ignore history failures
            }
          }
          return;
        }

        if (data?.legacyId) {
          if (typeof window !== 'undefined') {
            const destination = `/dashboard/guest-experience/cs?legacyId=${encodeURIComponent(
              String(data.legacyId)
            )}`;
            window.location.replace(destination);
          }
          return;
        }

        throw new Error('resolve_invalid');
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setConversationId(undefined);
        setResolverError(true);
      }
    }

    setConversationId(undefined);
    resolve();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialConversationId]);

  const resolvedConversation =
    typeof conversationId === 'string' && UUID_RE.test(conversationId)
      ? conversationId
      : undefined;

  return (
    <>
      {resolverError ? (
        <div
          role="alert"
          style={{
            margin: '16px',
            padding: '12px 16px',
            borderRadius: '8px',
            background: '#fef2f2',
            color: '#7f1d1d',
            fontSize: '0.875rem',
          }}
        >
          We couldn't resolve that conversation link.{' '}
          <a
            href="/link/help"
            style={{ color: '#7f1d1d', textDecoration: 'underline' }}
          >
            Get help
          </a>
          .
        </div>
      ) : null}
      <GuestExperience initialConversationId={resolvedConversation} />
    </>
  );
}
