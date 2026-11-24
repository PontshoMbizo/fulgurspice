// Document state: the schematic plus undo history, and the pure edits the UI makes.

import { newId, pointKey, route } from '../core/geometry';
import { onWire } from '../core/netlist';
import { SUBCKT_NAME, SYMBOLS, nextRef, pinPositions, symbolFor } from '../core/symbols';
import { sheetOf, syncInstances, withSheet } from '../core/subckt';
export { sheetOf, withSheet };
import { emptySchematic, type Part, type PartKind, type Point, type Rot, type Schematic, type Subckt, type Wire } from '../core/types';

export interface Doc { sch: Schematic; past: Schematic[]; future: Schematic[] }
/** `sheet`: when set, `sch` is that subcircuit's sheet and is merged back into the document. */
export type DocAction = { type: 'commit'; sch: Schematic; sheet?: string | null } | { type: 'load'; sch: Schematic } | { type: 'undo' } | { type: 'redo' };

const HISTORY = 200;

export function docReducer(doc: Doc, action: DocAction): Doc {
  switch (action.type) {
    case 'commit': { const sch = normalizeAll(withSheet(doc.sch, action.sheet ?? null, action.sch)); return sch === doc.sch ? doc : { sch, past: [...doc.past.slice(-HISTORY + 1), doc.sch], future: [] }; }
    case 'load': return { sch: normalizeAll(action.sch), past: [], future: [] };
    case 'undo': return doc.past.length ? { sch: doc.past[doc.past.length - 1], past: doc.past.slice(0, -1), future: [doc.sch, ...doc.future] } : doc;
    case 'redo': return doc.future.length ? { sch: doc.future[0], past: [...doc.past, doc.sch], future: doc.future.slice(1) } : doc;
  }
}

/** normalizeWires on the top sheet and on every subcircuit's sheet, then refresh the
 * port lists on instances so a symbol follows its definition. */
export function normalizeAll(sch: Schematic): Schematic {
  let out = normalizeWires(sch);
  const subckts = out.subckts.map((s) => { const n = normalizeWires({ ...out, parts: s.parts, wires: s.wires }); return n.wires === s.wires ? s : { ...s, wires: n.wires }; });
  if (subckts.some((s, i) => s !== out.subckts[i])) out = { ...out, subckts };
  return syncInstances(out);
}

/** Why `name` cannot be used for a new subcircuit, or null when it can. */
export function subcktNameProblem(sch: Schematic, name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the subcircuit a name';
  if (!SUBCKT_NAME.test(n)) return 'Use letters, digits and underscores, not starting with a digit';
  if (sch.subckts.some((s) => s.name.toLowerCase() === n.toLowerCase())) return `There is already a subcircuit called ${n}`;
  return null;
}

export const addSubckt = (sch: Schematic, name: string): Schematic => ({ ...sch, subckts: [...sch.subckts, { name: name.trim(), parts: [], wires: [] }] });
export const removeSubckt = (sch: Schematic, name: string): Schematic => ({ ...sch, subckts: sch.subckts.filter((s) => s.name !== name) });

const isEnd = (w: Wire, x: number, y: number) => (w.x1 === x && w.y1 === y) || (w.x2 === x && w.y2 === y);

/** Split any wire that a pin or another wire's endpoint lands on mid-span, then
 * merge collinear wire pairs that share an endpoint with nothing else on it. Run
 * once per commit (see docReducer) rather than after every individual edit. */
export function normalizeWires(sch: Schematic): Schematic {
  const split = splitWires(sch);
  const merged = mergeCollinear(sch, split);
  return merged === sch.wires ? sch : { ...sch, wires: merged };
}

function splitWires(sch: Schematic): Wire[] {
  let wires = sch.wires;
  for (let guard = 0; guard < 10000; guard++) {
    const landing: { x: number; y: number }[] = [];
    for (const part of sch.parts) for (const pin of pinPositions(part)) landing.push(pin);
    for (const w of wires) { landing.push({ x: w.x1, y: w.y1 }); landing.push({ x: w.x2, y: w.y2 }); }
    let hitIndex = -1, hitPoint: { x: number; y: number } | null = null;
    for (let i = 0; i < wires.length && hitIndex < 0; i++) {
      const w = wires[i];
      for (const p of landing) {
        if (onWire(w, p.x, p.y) && !isEnd(w, p.x, p.y)) { hitIndex = i; hitPoint = p; break; }
      }
    }
    if (hitIndex < 0) return wires;
    const w = wires[hitIndex];
    const pieces = [...route({ x: w.x1, y: w.y1 }, hitPoint!), ...route(hitPoint!, { x: w.x2, y: w.y2 })].map((s) => ({ id: uid(), ...s }));
    wires = [...wires.slice(0, hitIndex), ...pieces, ...wires.slice(hitIndex + 1)];
  }
  return wires;
}

function mergeCollinear(sch: Schematic, wires: Wire[]): Wire[] {
  const pinCount = new Map<string, number>();
  for (const part of sch.parts) for (const pin of pinPositions(part)) {
    const k = pointKey(pin.x, pin.y);
    pinCount.set(k, (pinCount.get(k) ?? 0) + 1);
  }
  for (let guard = 0; guard < 10000; guard++) {
    const at = new Map<string, number[]>();
    wires.forEach((w, i) => {
      for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]] as const) {
        const k = pointKey(x, y);
        const arr = at.get(k); if (arr) arr.push(i); else at.set(k, [i]);
      }
    });
    let mergedOne = false;
    for (const [k, idxs] of at) {
      if (pinCount.has(k) || idxs.length !== 2 || idxs[0] === idxs[1]) continue;
      const [ia, ib] = idxs;
      const A = wires[ia], B = wires[ib];
      const [px, py] = k.split(',').map(Number);
      const aFar = (A.x1 === px && A.y1 === py) ? { x: A.x2, y: A.y2 } : { x: A.x1, y: A.y1 };
      const bFar = (B.x1 === px && B.y1 === py) ? { x: B.x2, y: B.y2 } : { x: B.x1, y: B.y1 };
      const v1x = px - aFar.x, v1y = py - aFar.y;
      const v2x = bFar.x - px, v2y = bFar.y - py;
      const cross = v1x * v2y - v1y * v2x;
      const dot = v1x * v2x + v1y * v2y;
      if (cross !== 0 || dot <= 0) continue;
      const merged: Wire = { id: uid(), x1: aFar.x, y1: aFar.y, x2: bFar.x, y2: bFar.y };
      wires = [...wires.filter((_, i) => i !== ia && i !== ib), merged];
      mergedOne = true;
      break;
    }
    if (!mergedOne) break;
  }
  return wires;
}

export const uid = newId;

/** A fresh port name: in, then out, then p3, p4, … so new ports never collide. */
export function nextPortName(parts: Part[]): string {
  const used = new Set(parts.filter((p) => p.kind === 'PORT').map((p) => p.value.trim().toLowerCase()));
  for (const name of ['in', 'out']) if (!used.has(name)) return name;
  for (let k = 3; ; k++) if (!used.has(`p${k}`)) return `p${k}`;
}

export function addPart(sch: Schematic, kind: PartKind, x: number, y: number, rot: Rot, mirror: boolean, extra: { value?: string; ports?: string[] } = {}): { sch: Schematic; id: string } {
  const def = symbolFor({ kind, ports: extra.ports });
  const part: Part = { id: uid(), kind, ref: nextRef(sch.parts, def.prefix), x, y, rot, mirror, value: extra.value ?? (kind === 'PORT' ? nextPortName(sch.parts) : def.defaultValue) };
  if (extra.ports) part.ports = extra.ports;
  return { sch: { ...sch, parts: [...sch.parts, part] }, id: part.id };
}

export function addWires(sch: Schematic, segments: Omit<Wire, 'id'>[]): Schematic {
  const real = segments.filter((s) => s.x1 !== s.x2 || s.y1 !== s.y2).map((s) => ({ ...s, id: uid() }));
  return real.length ? { ...sch, wires: [...sch.wires, ...real] } : sch;
}

/** Move the selected parts/wires by (dx, dy). Any *other* wire that has exactly
 * one endpoint attached to a moving pin or wire-endpoint is rubber-banded: it
 * stretches (gaining a bend if needed) to follow, rather than being left behind. */
export function moveItems(sch: Schematic, ids: Set<string>, dx: number, dy: number): Schematic {
  if (!dx && !dy) return sch;
  const moving = new Set<string>();
  for (const p of sch.parts) if (ids.has(p.id)) for (const pin of pinPositions(p)) moving.add(pointKey(pin.x, pin.y));
  for (const w of sch.wires) if (ids.has(w.id)) { moving.add(pointKey(w.x1, w.y1)); moving.add(pointKey(w.x2, w.y2)); }

  const parts = sch.parts.map((p) => (ids.has(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p));
  const wires: Wire[] = [];
  for (const w of sch.wires) {
    if (ids.has(w.id)) { wires.push({ ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy }); continue; }
    const aMoving = moving.has(pointKey(w.x1, w.y1));
    const bMoving = moving.has(pointKey(w.x2, w.y2));
    if (!aMoving && !bMoving) { wires.push(w); continue; }
    if (aMoving && bMoving) { wires.push({ ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy }); continue; }
    const fixed = aMoving ? { x: w.x2, y: w.y2 } : { x: w.x1, y: w.y1 };
    const moved = aMoving ? { x: w.x1 + dx, y: w.y1 + dy } : { x: w.x2 + dx, y: w.y2 + dy };
    for (const seg of route(fixed, moved)) wires.push({ id: uid(), ...seg });
  }
  return { ...sch, parts, wires };
}

export function deleteItems(sch: Schematic, ids: Set<string>): Schematic {
  return { ...sch, parts: sch.parts.filter((p) => !ids.has(p.id)), wires: sch.wires.filter((w) => !ids.has(w.id)) };
}

export interface Clipboard { parts: Part[]; wires: Wire[] }

/** Snapshot the selected parts and wires for copy / duplicate. */
export function copyItems(sch: Schematic, ids: Set<string>): Clipboard {
  return { parts: sch.parts.filter((p) => ids.has(p.id)), wires: sch.wires.filter((w) => ids.has(w.id)) };
}

/** Add a clipboard's contents shifted by (dx, dy). New ids everywhere; parts get
 * the lowest free designator for their prefix (R1 -> R4), so references stay unique. */
export function pasteItems(sch: Schematic, clip: Clipboard, dx: number, dy: number): { sch: Schematic; ids: string[] } {
  const parts = [...sch.parts];
  const added: Part[] = [];
  for (const p of clip.parts) {
    const prefix = symbolFor(p).prefix;
    const copy: Part = { ...p, id: uid(), x: p.x + dx, y: p.y + dy, ref: prefix ? nextRef(parts, prefix) : '' };
    parts.push(copy); added.push(copy);
  }
  const wires = clip.wires.map((w): Wire => ({ id: uid(), x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy }));
  return { sch: { ...sch, parts, wires: [...sch.wires, ...wires] }, ids: [...added.map((p) => p.id), ...wires.map((w) => w.id)] };
}

/** Delete only the stretch of each selected wire around `at`, between the nearest
 * connection points on either side (pins, other wires' ends, the wire's own ends).
 * The rest of the run stays. A point that is on no selected wire changes nothing. */
export function removeWireSpan(sch: Schematic, ids: Set<string>, at: Point): Schematic {
  const stopsFor = (w: Wire): number[] => {
    const vertical = w.x1 === w.x2;
    const pts: Point[] = [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }];
    for (const part of sch.parts) for (const pin of pinPositions(part)) pts.push(pin);
    for (const o of sch.wires) if (o.id !== w.id) { pts.push({ x: o.x1, y: o.y1 }); pts.push({ x: o.x2, y: o.y2 }); }
    return [...new Set(pts.filter((q) => onWire(w, q.x, q.y)).map((q) => (vertical ? q.y : q.x)))].sort((a, b) => a - b);
  };
  let changed = false;
  const wires: Wire[] = [];
  for (const w of sch.wires) {
    if (!ids.has(w.id) || !onWire(w, at.x, at.y) || (w.x1 !== w.x2 && w.y1 !== w.y2)) { wires.push(w); continue; }
    const vertical = w.x1 === w.x2;
    const t = vertical ? at.y : at.x;
    const stops = stopsFor(w);
    let a = Math.max(...stops.filter((s) => s <= t)), b = Math.min(...stops.filter((s) => s >= t));
    if (a === b) { const next = stops.find((s) => s > t); if (next !== undefined) b = next; else a = Math.max(...stops.filter((s) => s < t)); }
    const seg = (from: number, to: number): Wire => (vertical ? { id: uid(), x1: w.x1, y1: from, x2: w.x1, y2: to } : { id: uid(), x1: from, y1: w.y1, x2: to, y2: w.y1 });
    const lo = stops[0], hi = stops[stops.length - 1];
    if (lo < a) wires.push(seg(lo, a));
    if (b < hi) wires.push(seg(b, hi));
    changed = true;
  }
  return changed ? { ...sch, wires } : sch;
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
  const parsePart = (p: Part): Part => {
    if (!p || !(p.kind in SYMBOLS)) throw new Error(`Unknown part kind "${String(p?.kind)}"`);
    if (![0, 90, 180, 270].includes(p.rot)) throw new Error('Schematic has a bad rotation');
    const off = (o: unknown): Point | undefined => { const q = o as Point | undefined; return q && (q.x || q.y) ? { x: int(q.x), y: int(q.y) } : undefined; };
    const part: Part = { id: String(p.id || uid()), kind: p.kind, ref: String(p.ref ?? ''), x: int(p.x), y: int(p.y), rot: p.rot, mirror: Boolean(p.mirror), value: String(p.value ?? '') };
    const refOffset = off(p.refOffset), valueOffset = off(p.valueOffset);
    if (refOffset) part.refOffset = refOffset;
    if (valueOffset) part.valueOffset = valueOffset;
    if (p.kind === 'SUBCKT' && Array.isArray(p.ports)) part.ports = p.ports.map(String);
    if (p.kind === 'SUBCKT' && typeof p.params === 'string' && p.params.trim()) part.params = p.params;
    if (p.bench) part.bench = true;
    return part;
  };
  const parseWire = (w: Wire): Wire => ({ id: String(w.id || uid()), x1: int(w.x1), y1: int(w.y1), x2: int(w.x2), y2: int(w.y2) });
  const parts = (Array.isArray(d.parts) ? d.parts : []).map(parsePart);
  const wires = (Array.isArray(d.wires) ? d.wires : []).map(parseWire);
  const subckts = (Array.isArray(d.subckts) ? d.subckts : []).map((s): Subckt => {
    if (!s || !SUBCKT_NAME.test(String(s.name))) throw new Error(`Bad subcircuit name "${String(s?.name)}"`);
    const params = typeof s.params === 'string' && s.params.trim() ? { params: s.params } : {};
    return { name: String(s.name), ...params, parts: (Array.isArray(s.parts) ? s.parts : []).map(parsePart), wires: (Array.isArray(s.wires) ? s.wires : []).map(parseWire) };
  });
  const base = emptySchematic();
  const a = d.analysis;
  const analysis = a && ['tran', 'ac', 'dc', 'op'].includes(a.kind) ? a : base.analysis;
  const sw = d.sweep && typeof d.sweep.param === 'string' ? { sweep: { param: d.sweep.param, values: String(d.sweep.values ?? '') } } : {};
  return syncInstances({ ...base, title: String(d.title ?? base.title), parts, wires, analysis, directives: String(d.directives ?? ''), subckts, ...sw });
}

const KEY = 'fulgurspice:schematic';

export function loadSaved(): Schematic | null {
  try { const text = localStorage.getItem(KEY); return text ? parseSchematic(text) : null; } catch { return null; }
}

export function saveLocal(sch: Schematic) {
  try { localStorage.setItem(KEY, JSON.stringify(sch)); } catch { /* storage unavailable: autosave is a convenience */ }
}
