// A small centered popover shell, shared by the quick-add part search box and
// the "name this subcircuit" prompt. Escape or a click on the backdrop closes it;
// everything else (the input, the list, the buttons) is up to the caller.

import type { ReactNode } from 'react';

export function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="overlay-backdrop"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div className="overlay-box" role="dialog">{children}</div>
    </div>
  );
}
