import { redirect } from 'next/navigation.js';
import { headers } from 'next/headers.js';
import { getSession } from '../lib/auth';

export default async function Root() {
  const session = await getSession(headers());
  redirect(session ? '/dashboard/guest-experience/all' : '/login');
}
