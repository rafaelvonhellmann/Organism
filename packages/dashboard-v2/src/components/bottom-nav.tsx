'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', icon: '>', label: 'Review' },
  { href: '/assessments', icon: '&', label: 'Assess' },
  { href: '/plan', icon: '!', label: 'Plan' },
  { href: '/progress', icon: '%', label: 'Progress' },
  { href: '/budget', icon: '$', label: 'Budget' },
  { href: '/feedback', icon: '?', label: 'Feedback' },
];

export function BottomNav() {
  const pathname = usePathname();

  // Hide the bottom nav on the review queue page since it has its own fixed action bar
  if (pathname === '/') return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden bg-surface border-t border-edge">
      <div className="flex justify-around items-center h-14">
        {NAV_ITEMS.map(item => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center gap-0.5 px-3 py-1 text-xs transition-colors ${
                isActive ? 'text-emerald-400' : 'text-zinc-500'
              }`}
            >
              <span className="text-lg font-mono">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
