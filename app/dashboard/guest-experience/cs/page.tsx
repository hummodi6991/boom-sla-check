import { redirect } from 'next/navigation';

export default function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams || {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v != null) q.set(k, v);
  }
  const qs = q.toString();
  redirect(`/dashboard/guest-experience/all${qs ? `?${qs}` : ''}`);
}
