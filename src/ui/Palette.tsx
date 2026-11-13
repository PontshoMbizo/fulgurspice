import { SYMBOLS, type SymbolDef } from '../core/symbols';
import type { PartKind } from '../core/types';

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

export function Palette({ active, onPick }: { active: PartKind | null; onPick: (kind: PartKind) => void }) {
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
                  <button type="button" aria-pressed={active === def.kind} onClick={() => onPick(def.kind)}>
                    <Glyph def={def} />
                    <span>{def.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
