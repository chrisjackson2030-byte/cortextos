import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Jarvis · Check-in' };

// Standalone full-screen layout for the mobile check-in — deliberately OUTSIDE the
// (dashboard) group so it gets NONE of the desktop chrome (sidebar, topbar org
// selector, bottom nav). That chrome was eating space + overlapping content + breaking
// scroll on a phone. Here the page scrolls naturally on the body. Auth still enforced.
export default async function MobileLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect('/login');
  return <div style={{ background: '#0A0E17', minHeight: '100dvh' }}>{children}</div>;
}
