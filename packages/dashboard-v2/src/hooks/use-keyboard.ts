'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export function useKeyboardShortcuts(handlers?: Record<string, () => void>) {
  const router = useRouter();
  const gPressedRef = useRef(false);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const key = e.key.toLowerCase();

      // G + key navigation
      if (gPressedRef.current) {
        gPressedRef.current = false;
        clearTimeout(timeoutRef.current);
        switch (key) {
          case 'i': router.push('/'); return;
          case 'p': router.push('/plan'); return;
          case 's': router.push('/system'); return;
          case 'c': router.push('/command'); return;
          case 'n': router.push('/insights'); return;
          case 'm': router.push('/guide'); return;
        }
        return;
      }

      if (key === 'g') {
        gPressedRef.current = true;
        timeoutRef.current = setTimeout(() => { gPressedRef.current = false; }, 1000);
        return;
      }

      // ? = show help
      if (key === '?' && !e.shiftKey) {
        handlers?.['?']?.();
        return;
      }

      // Page-specific handlers
      if (handlers?.[key]) {
        handlers[key]();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [router, handlers]);
}
