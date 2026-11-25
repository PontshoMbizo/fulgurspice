// Left-hand parts library, as in the suite's shared layout: a search box and the part groups
// from SYMBOLS. Clicking a part starts placing it, exactly like the A box (QuickAdd); the
// subcircuits defined in this document are listed last.

import { useMemo, useState } from 'react';
import { SYMBOLS, subcktSymbol, type SymbolDef } from '../core/symbols';
import { subcktPorts } from '../core/subckt';
import type { PartKind, Subckt } from '../core/types';
import { IconLibrary } from './Icons';

const GROUPS: SymbolDef['group'][] = ['Connectivity', 'Passive', 'Sources', 'Semiconductors'];

function Glyph({ def }: { def: SymbolDef }) {
  const [x0, y0, x1, y1] = def.box;
  const size = Math.max(x1 - x0, y1 - y0) + 0.8;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return (
    <svg className="library-glyph" width="18" height="18" viewBox={`${cx - size / 2} ${cy - size / 2} ${size} ${size}`} aria-hidden="true">
      {def.body && <path className="sym-body" d={def.body} />}
      <path className="sym" d={def.path} />
      {def.solid && <path className="sym-solid" d={def.solid} />}
    </svg>
  );
}

interface Props {
  /** The kind being placed (null when not placing), and for a subcircuit which one. */
  active: PartKind | null;
  activeSubckt: string | null;
  subckts: Subckt[];
  /** Subcircuit ports only make sense on a subcircuit's own sheet. */
  canPlacePort: boolean;
  onPick: (kind: PartKind) => void;
  onPickSubckt: (name: string) => void;
}

export function PartsLibrary({ active, activeSubckt, subckts, canPlacePort, onPick, onPickSubckt }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (label: string, extra = '') => !q || label.toLowerCase().includes(q) || extra.toLowerCase() === q;
  const groups = useMemo(() => GROUPS.map((group) => ({
    group,
    items: Object.values(SYMBOLS).filter((d) => d.group === group && (d.kind !== 'PORT' || canPlacePort) && match(d.label, d.prefix)),
  })).filter((g) => g.items.length), [q, canPlacePort]); // eslint-disable-line react-hooks/exhaustive-deps
  const subs = subckts.filter((s) => match(s.name));

  return (
    <aside className="library" aria-label="Parts">
      <div className="panel-title"><IconLibrary /> Parts</div>
      <div className="library-body">
        <input type="search" value={query} placeholder="Search parts…" aria-label="Search parts" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        {groups.map(({ group, items }) => (
          <section key={group}>
            <div className="library-group">{group}</div>
            {items.map((def) => (
              <button key={def.kind} type="button" className="library-item" aria-pressed={active === def.kind && !activeSubckt} title={`Place ${def.label.toLowerCase()}`} onClick={() => onPick(def.kind)}>
                <Glyph def={def} />
                <span>{def.label}</span>
              </button>
            ))}
          </section>
        ))}
        {subs.length > 0 && (
          <section>
            <div className="library-group">Subcircuits</div>
            {subs.map((s) => (
              <button key={s.name} type="button" className="library-item" aria-pressed={activeSubckt === s.name} title={`Place an instance of ${s.name}`} onClick={() => onPickSubckt(s.name)}>
                <Glyph def={subcktSymbol(subcktPorts(s))} />
                <span>{s.name}</span>
              </button>
            ))}
          </section>
        )}
        {!groups.length && !subs.length && <div className="library-empty">No part matches “{query}”.</div>}
      </div>
    </aside>
  );
}
