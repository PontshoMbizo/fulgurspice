// Subcircuit bookkeeping that is pure data: which ports a definition has, renaming,
// and keeping every instance (and the wires on its pins) in step with its definition.

import { newId, pointKey, route } from './geometry';
import { pinPositions } from './symbols';
import type { Part, Point, Schematic, Subckt, Wire } from './types';

/** A definition's port names, in placement order (the order of its PORT parts). */
export const subcktPorts = (def: Pick<Subckt, 'parts'>): string[] => def.parts.filter((p) => p.kind === 'PORT' && !p.bench).map((p) => p.value.trim());

const same = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

const isInstanceOf = (p: Part, name: string) => p.kind === 'SUBCKT' && p.value.trim().toLowerCase() === name.toLowerCase();

/** Rename a definition and every instance of it, on the top sheet and inside other subcircuits. */
export function renameSubckt(sch: Schematic, from: string, to: string): Schematic {
  const next = to.trim();
  const rename = (parts: Part[]) => (parts.some((p) => isInstanceOf(p, from)) ? parts.map((p) => (isInstanceOf(p, from) ? { ...p, value: next } : p)) : parts);
  return {
    ...sch,
    parts: rename(sch.parts),
    subckts: sch.subckts.map((s) => ({ ...s, name: s.name.toLowerCase() === from.toLowerCase() ? next : s.name, parts: rename(s.parts) })),
  };
}

/** How old pin names map onto new ones: by name where it survives, then in order for
 * the leftovers when their counts match (so a renamed port keeps its wire). */
function matchPorts(oldPorts: string[], newPorts: string[]): Map<number, number> {
  const out = new Map<number, number>();
  const taken = new Set<number>();
  oldPorts.forEach((name, i) => {
    const j = newPorts.findIndex((m, k) => m === name && !taken.has(k));
    if (j >= 0) { out.set(i, j); taken.add(j); }
  });
  const lostOld = oldPorts.map((_, i) => i).filter((i) => !out.has(i));
  const lostNew = newPorts.map((_, j) => j).filter((j) => !taken.has(j));
  if (lostOld.length === lostNew.length) lostOld.forEach((i, k) => out.set(i, lostNew[k]));
  return out;
}

/** Re-route wires whose endpoint sat on a pin that has moved, rubber-band style. */
function followPins(wires: Wire[], moves: Map<string, Point>): Wire[] {
  if (!moves.size) return wires;
  const out: Wire[] = [];
  for (const w of wires) {
    const a = moves.get(pointKey(w.x1, w.y1)), b = moves.get(pointKey(w.x2, w.y2));
    if (!a && !b) { out.push(w); continue; }
    for (const seg of route(a ?? { x: w.x1, y: w.y1 }, b ?? { x: w.x2, y: w.y2 })) out.push({ id: newId(), ...seg });
  }
  return out;
}

/** Copy each definition's ports onto every instance of it (on the top sheet and inside
 * other subcircuits). When an instance's pins move, wires attached to the pins that
 * survive follow them. Returns the same object when nothing changed. Instances whose
 * definition is missing keep the ports they had, so the symbol does not collapse. */
export function syncInstances(sch: Schematic): Schematic {
  const defs = new Map(sch.subckts.map((s) => [s.name.toLowerCase(), s]));
  let changed = false;
  const fix = (parts: Part[], wires: Wire[]): { parts: Part[]; wires: Wire[] } => {
    const moves = new Map<string, Point>();
    let touched = false;
    const next = parts.map((p) => {
      if (p.kind !== 'SUBCKT') return p;
      const def = defs.get(p.value.trim().toLowerCase());
      if (!def) return p;
      const ports = subcktPorts(def);
      if (same(p.ports, ports)) return p;
      touched = true;
      const updated = { ...p, ports };
      const before = pinPositions(p), after = pinPositions(updated);
      for (const [i, j] of matchPorts(p.ports ?? [], ports)) {
        const from = before[i], to = after[j];
        if (from.x !== to.x || from.y !== to.y) moves.set(pointKey(from.x, from.y), { x: to.x, y: to.y });
      }
      return updated;
    });
    if (!touched) return { parts, wires };
    changed = true;
    return { parts: next, wires: followPins(wires, moves) };
  };
  const top = fix(sch.parts, sch.wires);
  const subckts = sch.subckts.map((s) => { const f = fix(s.parts, s.wires); return f.parts === s.parts ? s : { ...s, parts: f.parts, wires: f.wires }; });
  return changed ? { ...sch, parts: top.parts, wires: top.wires, subckts } : sch;
}

/** The sheet being edited as an ordinary Schematic: the top sheet when `name` is null. */
export function sheetOf(sch: Schematic, name: string | null): Schematic {
  const def = name === null ? undefined : sch.subckts.find((s) => s.name === name);
  return def ? { ...sch, title: def.name, parts: def.parts, wires: def.wires } : sch;
}

/** Store an edited sheet back: the whole schematic when `name` is null, else just that subcircuit's parts and wires. */
export function withSheet(sch: Schematic, name: string | null, next: Schematic): Schematic {
  if (name === null) return next;
  return { ...sch, subckts: sch.subckts.map((s) => (s.name === name ? { ...s, parts: next.parts, wires: next.wires } : s)) };
}
