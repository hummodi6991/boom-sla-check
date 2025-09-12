'use client';
import { useEffect } from 'react';

export default function Home() {
  useEffect(() => {
    const to = '/dashboard/guest-experience/cs';
    if (location.pathname !== to) location.replace(to);
  }, []);
  return <p>Redirecting…</p>;
}
