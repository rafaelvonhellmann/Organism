'use client';

import { useState, useCallback, useEffect } from 'react';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard';
import { KeyboardHelp } from '@/components/keyboard-help';

export function ShortcutProvider({ children }: { children: React.ReactNode }) {
  const [showHelp, setShowHelp] = useState(false);

  const toggleHelp = useCallback(() => setShowHelp(prev => !prev), []);
  const closeHelp = useCallback(() => setShowHelp(false), []);

  // Close on Escape
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape' && showHelp) {
        setShowHelp(false);
      }
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [showHelp]);

  useKeyboardShortcuts({ '?': toggleHelp });

  return (
    <>
      {children}
      <KeyboardHelp open={showHelp} onClose={closeHelp} />
    </>
  );
}
