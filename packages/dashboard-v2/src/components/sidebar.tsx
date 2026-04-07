'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from './theme-provider';

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Review Queue', icon: '>' },
  { href: '/bets', label: 'Shape Up', icon: '^' },
  { href: '/assessments', label: 'Assessments', icon: '&' },
  { href: '/plan', label: 'Action Plan', icon: '!' },
  { href: '/roadmap', label: 'Roadmap', icon: '~' },
  { href: '/progress', label: 'Progress', icon: '%' },
  { href: '/history', label: 'History', icon: '#' },
  { href: '/budget', label: 'Budget', icon: '$' },
  { href: '/feedback', label: 'Feedback', icon: '?' },
  { href: '/palate', label: 'Palate', icon: '*' },
  { href: '/agents', label: 'Agents', icon: '@' },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [todoCount, setTodoCount] = useState(0);
  const { theme, toggle: toggleTheme } = useTheme();

  const fetchCount = useCallback(() => {
    fetch('/api/review-queue')
      .then(r => r.json())
      .then(d => setPendingCount(d.pending ?? d.total ?? 0))
      .catch(() => {});
    fetch('/api/action-items?counts=1')
      .then(r => r.json())
      .then(d => setTodoCount(d.todo ?? 0))
      .catch(() => {});
  }, []);

  // Fetch pending review count for badge
  useEffect(() => {
    fetchCount();
    const id = setInterval(fetchCount, 60_000);
    return () => clearInterval(id);
  }, [fetchCount]);

  // Listen for custom "review-decision" events from the review page
  // so the count updates immediately after a decision
  useEffect(() => {
    function handleDecision() {
      setPendingCount(c => Math.max(0, c - 1));
      // Also re-fetch to get the true count
      setTimeout(fetchCount, 1000);
    }
    window.addEventListener('review-decision', handleDecision);
    return () => window.removeEventListener('review-decision', handleDecision);
  }, [fetchCount]);

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="px-5 py-5 border-b border-edge">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
          <svg className="inline-block w-5 h-5 mr-1.5 -mt-0.5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2c-2 4-6 6-6 12a6 6 0 0 0 12 0c0-6-4-8-6-12z" />
            <path d="M12 8c-1 2-3 3-3 6a3 3 0 0 0 6 0c0-3-2-4-3-6z" />
          </svg>
          Organism
        </h1>
        <p className="text-xs text-zinc-500 mt-0.5">Living Knowledge System</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.map(({ href, label, icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
              }`}
            >
              <span className="text-base w-5 text-center font-mono">{icon}</span>
              <span className="flex-1">{label}</span>
              {href === '/' && pendingCount > 0 && (
                <span className="ml-auto bg-emerald-500/20 text-emerald-400 text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                  {pendingCount}
                </span>
              )}
              {href === '/plan' && todoCount > 0 && (
                <span className="ml-auto bg-blue-500/20 text-blue-400 text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                  {todoCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-edge">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500 dark:text-zinc-500 light:text-zinc-400">
            Organism v0.3.0
          </span>
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 dark:hover:bg-zinc-800/50 transition-colors"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile hamburger - only visible on small screens */}
      <button
        className="fixed top-3 left-3 z-40 md:hidden p-2 rounded-lg bg-surface border border-edge"
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
      >
        <span className="text-zinc-300 text-lg leading-none">&#9776;</span>
      </button>

      {/* Desktop sidebar - always visible on md+ */}
      <aside className="hidden md:flex fixed top-0 left-0 h-screen w-56 bg-surface border-r border-edge flex-col z-30">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          {/* Sliding panel */}
          <aside className="absolute top-0 left-0 h-full w-56 bg-surface border-r border-edge flex flex-col animate-slide-in">
            {/* Close button */}
            <button
              className="absolute top-3 right-3 z-10 p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <span className="text-lg leading-none">&#10005;</span>
            </button>
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
