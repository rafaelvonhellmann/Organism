'use client';

export function KeyboardHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-zinc-100 mb-4">Keyboard Shortcuts</h2>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Navigation (press G then...)</p>
            <div className="grid grid-cols-2 gap-1 text-sm">
              <Shortcut keys="G I" label="Inbox" />
              <Shortcut keys="G P" label="Plan" />
              <Shortcut keys="G S" label="System" />
              <Shortcut keys="G C" label="Command" />
              <Shortcut keys="G N" label="Insights" />
              <Shortcut keys="G M" label="Manual" />
            </div>
          </div>

          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Inbox Actions</p>
            <div className="grid grid-cols-2 gap-1 text-sm">
              <Shortcut keys="A" label="Approve" />
              <Shortcut keys="D" label="Dismiss" />
              <Shortcut keys="S" label="Skip" />
              <Shortcut keys="R" label="Reply" />
              <Shortcut keys="J" label="Next item" />
              <Shortcut keys="K" label="Previous item" />
            </div>
          </div>

          <div>
            <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">General</p>
            <div className="grid grid-cols-2 gap-1 text-sm">
              <Shortcut keys="?" label="This help" />
              <Shortcut keys="Esc" label="Close overlay" />
            </div>
          </div>
        </div>

        <button onClick={onClose} className="mt-4 text-xs text-zinc-500 hover:text-zinc-300">Close (Esc)</button>
      </div>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-400">{keys}</kbd>
      <span className="text-zinc-400">{label}</span>
    </div>
  );
}
