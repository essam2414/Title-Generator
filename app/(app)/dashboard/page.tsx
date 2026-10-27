import { redirect } from 'next/navigation';

// Keep older bookmarks and links working; /app is the canonical dashboard URL.
export default function DashboardRedirect() {
  redirect('/app');
}
