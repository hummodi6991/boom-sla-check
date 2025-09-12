import { redirect } from 'next/navigation';

// Note: Next passes `searchParams` to Server Components at render time.
export default function Page({
  searchParams,
}: {
  // Support string | string[] | undefined to match Next types.
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Rebuild the query string while preserving multi-value params.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else if (value != null) {
      params.set(key, value);
    }
  }

  const qs = params.toString();
  redirect(`/dashboard/guest-experience/all${qs ? `?${qs}` : ''}`);
}
