// KiCad's "A" box: type part of a name (or its prefix letter), Enter places it.

import { useMemo, useState } from 'react';
import { SYMBOLS } from '../core/symbols';
import type { PartKind, Subckt } from '../core/types';
import { Overlay } from './Overlay';

type Entry = { key: string; label: string; kind: PartKind; group: string; prefix: string; subckt?: string };

export function QuickAdd({ subckts, onPick, onPickSubckt, onClose }: { subckts: Subckt[]; onPick: (kind: PartKind) => void; onPickSubckt: (name: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Entry[] = [
      ...Object.values(SYMBOLS).filter((d) => d.kind !== 'SUBCKT').map((d) => ({ key: d.kind, label: d.label, kind: d.kind, group: d.group, prefix: d.prefix })),
      ...subckts.map((s) => ({ key: `sub:${s.name}`, label: s.name, kind: 'SUBCKT' as PartKind, group: 'Subcircuit', prefix: 'X', subckt: s.name })),
    ];
    if (!q) return all;
    const score = (d: Entry) => {
      const label = d.label.toLowerCase(), kind = d.subckt ? label : d.kind.toLowerCase();
      if (kind === q || d.prefix.toLowerCase() === q) return 0;
      if (label.startsWith(q) || kind.startsWith(q)) return 1;
      if (label.includes(q)) return 2;
      return -1;
    };
    return all.map((d) => [d, score(d)] as const).filter(([, s]) => s >= 0).sort((a, b) => a[1] - b[1]).map(([d]) => d);
  }, [query, subckts]);
  const choose = (i: number) => { const d = matches[i]; if (d) { if (d.subckt) onPickSubckt(d.subckt); else onPick(d.kind); } };

  return (
    <Overlay onClose={onClose}>
      <input
        autoFocus placeholder="Add part: type a name, e.g. res, cap, npn, gnd" aria-label="Part name"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
        }}
      />
      {matches.length ? (
        <ul className="overlay-list">
          {matches.map((d, i) => (
            <li key={d.key}>
              <button type="button" className={i === active ? 'is-active' : ''} onClick={() => choose(i)}>
                <span>{d.label}</span><span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11 }}>{d.group}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="overlay-empty">No part matches “{query}”.</div>}
    </Overlay>
  );
}
