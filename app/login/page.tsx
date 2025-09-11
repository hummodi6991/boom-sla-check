'use client';
import { useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const sp = useSearchParams();
  const next = sp.get('next') ?? '/';
    return (
      <main style={{ maxWidth: 360, margin: '4rem auto', fontFamily: 'system-ui' }}>
        <h1>Sign in</h1>
        <form method="post" action="/api/login">
          <input
            name="email"
            type="email"
            placeholder="email"
            required
            style={{ display: 'block', width: '100%', margin: '8px 0' }}
          />
          <input
            name="password"
            type="password"
            placeholder="password"
            required
            style={{ display: 'block', width: '100%', margin: '8px 0' }}
          />
          <input type="hidden" name="next" value={next} />
          <button type="submit">Sign in</button>
        </form>
      </main>
    );
}

