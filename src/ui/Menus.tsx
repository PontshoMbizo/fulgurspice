import { useEffect, useRef, useState } from 'react';

export type MenuItem =
  | { label: string; shortcut?: string; disabled?: boolean; run: () => void }
  | { separator: true }
  | { heading: string };

export function MenuBar({ menus }: { menus: { title: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div ref={ref} className="menus">
      {menus.map((menu) => (
        <div className="menu" key={menu.title}>
          <button type="button" className={`menu-title${open === menu.title ? ' is-open' : ''}`} aria-haspopup="menu" aria-expanded={open === menu.title}
            onClick={() => setOpen(open === menu.title ? null : menu.title)} onPointerEnter={() => { if (open) setOpen(menu.title); }}>
            {menu.title}
          </button>
          {open === menu.title && (
            <ul className="menu-list" role="menu">
              {menu.items.map((item, i) => 'separator' in item ? <li key={i} role="separator"><hr /></li>
                : 'heading' in item ? <li key={i} className="menu-heading">{item.heading}</li>
                : (
                  <li key={i} role="none">
                    <button type="button" role="menuitem" disabled={item.disabled} onClick={() => { setOpen(null); item.run(); }}>
                      <span className="menu-label">{item.label}</span>
                      {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
