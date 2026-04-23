import { getCurrentAuthUser } from '@seaking/auth/server';
import { redirect } from 'next/navigation';

export default async function Home() {
  const user = await getCurrentAuthUser();
  if (!user) {
    redirect('/login');
  }
  redirect('/clients');
}
