// Document state: the schematic plus undo history, and the pure edits the UI makes.

import { SYMBOLS, nextRef } from '../core/symbols';
import { emptySchematic, type Part, type PartKind, type Rot, type Schematic, type Wire } from '../core/types';

export interface Doc { sch: Schematic; past: Schematic[]; future: Schematic[] }
export type DocAction = { type: 'commit'; sch: Schematic } | { type: 'load'; sch: Schematic } | { type: 'undo' } | { type: 'redo' };

const HISTORY = 200;

export function docReducer(doc: Doc, action: DocAction): Doc {
  switch (action.type) {
    case 'commit': return action.sch === doc.sch ? doc : { sch: action.sch, past: [...doc.past.slice(-HISTORY + 1), doc.sch], future: [] };
    case 'load': return { sch: action.sch, past: [], future: [] };
    case 'undo': return doc.past.length ? { sch: doc.past[doc.past.length - 1], past: doc.past.slice(0, -1), future: [doc.sch, ...doc.future] } : doc;
    case 'redo': return doc.future.length ? { sch: doc.future[0], past: [...doc.past, doc.sch], future: doc.future.slice(1) } : doc;
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function addPart(sch: Schematic, kind: PartKind, x: number, y: number, rot: Rot, mirror: boolean): { sch: Schematic; id: string } {
  const def = SYMBOLS[kind];
  const part: Part = { id: uid(), kind, ref: nextRef(sch.parts, def.prefix), x, y, rot, mirror, value: def.defaultValue };
  return { sch: { ...sch, parts: [...sch.parts, part] }, id: part.id };
}

export function addWires(sch: Schematic, segments: Omit<Wire, 'id'>[]): Schematic {
  const real = segments.filter((s) => s.x1 !== s.x2 || s.y1 !== s.y2).map((s) => ({ ...s, id: uid() }));
  return real.length ? { ...sch, wires: [...sch.wires, ...real] } : sch;
}

export function moveItems(sch: Schematic, ids: Set<string>, dx: number, dy: number): Schematic {
  if (!dx && !dy) return sch;
  return {
    ...sch,
    parts: sch.parts.map((p) => (ids.has(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p)),
    wires: sch.wires.map((w) => (ids.has(w.id) ? { ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy } : w)),
  };
}

export function deleteItems(sch: Schematic, ids: Set<string>): Schematic {
  return { ...sch, parts: sch.parts.filter((p) => !ids.has(p.id)), wires: sch.wires.filter((w) => !ids.has(w.id)) };
}

export function patchParts(sch: Schematic, ids: Set<string>, patch: (p: Part) => Partial<Part>): Schematic {
  return { ...sch, parts: sch.parts.map((p) => (ids.has(p.id) ? { ...p, ...patch(p) } : p)) };
}

export const rotated = (rot: Rot): Rot => ((rot + 90) % 360) as Rot;

/** Validate a loaded file. Throws with a message fit for the status bar. */
export function parseSchematic(text: string): Schematic {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not JSON'); }
  const d = data as Partial<Schematic>;
  if (!d || d.format !== 'fulgurspice-schematic') throw new Error('That is not a fulgurspice schematic');
  if (d.version !== 1) throw new Error(`Schematic version ${String(d.version)} is newer than this editor`);
  const int = (v: unknown) => { if (!Number.isInteger(v)) throw new Error('Schematic has an off-grid coordinate'); return v as number; };
  const parts = (Array.isArray(d.parts) ? d.parts : []).map((p): Part => {
    if (!p || !(p.kind in SYMBOLS)) throw new Error(`Unknown part kind "${String(p?.kind)}"`);
    if (![0, 90, 180, 270].includes(p.rot)) throw new Error('Schematic has a bad rotation');
    return { id: String(p.id || uid()), kind: p.kind, ref: String(p.ref ?? ''), x: int(p.x), y: int(p.y), rot: p.rot, mirror: Boolean(p.mirror), value: String(p.value ?? '') };
  });
  const wires = (Array.isArray(d.wires) ? d.wires : []).map((w): Wire => ({ id: String(w.id || uid()), x1: int(w.x1), y1: int(w.y1), x2: int(w.x2), y2: int(w.y2) }));
  const base = emptySchematic();
  const a = d.analysis;
  const analysis = a && ['tran', 'ac', 'dc', 'op'].includes(a.kind) ? a : base.analysis;
  return { ...base, title: String(d.title ?? base.title), parts, wires, analysis, directives: String(d.directives ?? '') };
}

const KEY = 'fulgurspice:schematic';

export function loadSaved(): Schematic | null {
  try { const text = localStorage.getItem(KEY); return text ? parseSchematic(text) : null; } catch { return null; }
}

export function saveLocal(sch: Schematic) {
  try { localStorage.setItem(KEY, JSON.stringify(sch)); } catch { /* storage unavailable: autosave is a convenience */ }
}
