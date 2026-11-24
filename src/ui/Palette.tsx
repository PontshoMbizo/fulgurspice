import { SYMBOLS, subcktSymbol, type SymbolDef } from '../core/symbols';
import { subcktPorts } from '../core/subckt';
import type { PartKind, Subckt } from '../core/types';

const GROUPS: SymbolDef['group'][] = ['Connectivity', 'Passive', 'Sources', 'Semiconductors'];

function Glyph({ def }: { def: SymbolDef }) {
  const [x0, y0, x1, y1] = def.box;
  const size = Math.max(x1 - x0, y1 - y0) + 0.8;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return (
    <svg className="palette-glyph" width="30" height="30" viewBox={`${cx - size / 2} ${cy - size / 2} ${size} ${size}`} aria-hidden="true">
      {def.body && <path className="sym-body" d={def.body} />}
      <path className="sym" d={def.path} />
      {def.solid && <path className="sym-solid" d={def.solid} />}
    </svg>
  );
}

interface PaletteProps {
  /** The kind being placed, and for a subcircuit which one. */
  active: PartKind | null;
  activeSubckt: string | null;
  subckts: Subckt[];
  onPick: (kind: PartKind) => void;
  onPickSubckt: (name: string) => void;
  onOpenSubckt: (name: string) => void;
  onNewSubckt: () => void;
  onDeleteSubckt: (name: string) => void;
}

export function Palette({ active, activeSubckt, subckts, onPick, onPickSubckt, onOpenSubckt, onNewSubckt, onDeleteSubckt }: PaletteProps) {
  return (
    <aside className="palette" aria-label="Parts">
      <div className="panel-title">Parts</div>
      <div className="palette-tree">
        {GROUPS.map((group) => (
          <section key={group}>
            <div className="palette-group">{group}</div>
            <ul>
              {Object.values(SYMBOLS).filter((d) => d.group === group).map((def) => (
                <li key={def.kind}>
                  <button type="button" aria-pressed={active === def.kind && !activeSubckt} onClick={() => onPick(def.kind)}>
                    <Glyph def={def} />
                    <span>{def.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section>
          <div className="palette-group">Subcircuits</div>
          <ul>
            {subckts.map((s) => (
              <li key={s.name} className="palette-subckt">
                <button type="button" aria-pressed={activeSubckt === s.name} title="Place an instance" onClick={() => onPickSubckt(s.name)}>
                  <Glyph def={subcktSymbol(subcktPorts(s))} />
                  <span>{s.name}</span>
                </button>
                <button type="button" className="palette-mini" title={`Edit ${s.name}`} aria-label={`Edit ${s.name}`} onClick={() => onOpenSubckt(s.name)}>✎</button>
                <button type="button" className="palette-mini" title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`} onClick={() => onDeleteSubckt(s.name)}>×</button>
              </li>
            ))}
            <li><button type="button" className="palette-new" onClick={onNewSubckt}><span>New subcircuit…</span></button></li>
          </ul>
        </section>
      </div>
    </aside>
  );
}
