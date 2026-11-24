// Subcircuit bookkeeping that is pure data: which ports a definition has, and keeping
// every instance's port list in step with its definition.

import type { Part, Schematic, Subckt } from './types';

/** A definition's port names, in placement order (the order of its PORT parts). */
export const subcktPorts = (def: Pick<Subckt, 'parts'>): string[] => def.parts.filter((p) => p.kind === 'PORT').map((p) => p.value.trim());

const same = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

/** Copy each definition's ports onto every instance of it (on the top sheet and inside
 * other subcircuits). Returns the same object when nothing changed. Instances whose
 * definition is missing keep the ports they had, so the symbol does not collapse. */
export function syncInstances(sch: Schematic): Schematic {
  const defs = new Map(sch.subckts.map((s) => [s.name.toLowerCase(), s]));
  let changed = false;
  const fix = (parts: Part[]): Part[] => {
    let touched = false;
    const next = parts.map((p) => {
      if (p.kind !== 'SUBCKT') return p;
      const def = defs.get(p.value.trim().toLowerCase());
      if (!def) return p;
      const ports = subcktPorts(def);
      if (same(p.ports, ports)) return p;
      touched = true;
      return { ...p, ports };
    });
    if (touched) changed = true;
    return touched ? next : parts;
  };
  const parts = fix(sch.parts);
  const subckts = sch.subckts.map((s) => { const p = fix(s.parts); return p === s.parts ? s : { ...s, parts: p }; });
  return changed ? { ...sch, parts, subckts } : sch;
}
