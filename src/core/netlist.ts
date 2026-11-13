// Schematic -> SPICE netlist. The netlist text is the only thing the engine ever
// sees, so the same output runs in the browser (ngspice-wasm), on a server, or in
// desktop ngspice when a result needs a second opinion.
//
// Connectivity rule: a pin or wire end that lies anywhere on a wire is connected
// to it. Two wires that merely cross are not.

import type { Analysis, Part, Point, Schematic, Wire } from './types';
import { MODELS, SYMBOLS, pinPositions } from './symbols';
import { parseSI, toSpice } from './units';

export interface Issue {
  level: 'error' | 'warning';
  message: string;
  partId?: string;
  at?: Point;
}

export interface Compiled {
  netlist: string;
  issues: Issue[];
  /** No errors: the netlist is worth sending to the engine. */
  ok: boolean;
  /** `${partId}:${pinName}` -> node name */
  pinNode: Map<string, string>;
  wireNode: Map<string, string>;
  nodes: string[];
  /** Where to draw junction dots (three or more connections meet). */
  junctions: Point[];
}

const key = (x: number, y: number) => `${x},${y}`;

class UnionFind {
  private parent = new Map<string, string>();
  add(k: string) { if (!this.parent.has(k)) this.parent.set(k, k); }
  find(k: string): string {
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    while (this.parent.get(k) !== r) { const next = this.parent.get(k)!; this.parent.set(k, r); k = next; }
    return r;
  }
  union(a: string, b: string) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

export function onWire(w: Wire, x: number, y: number): boolean {
  if ((w.x2 - w.x1) * (y - w.y1) !== (w.y2 - w.y1) * (x - w.x1)) return false;
  return x >= Math.min(w.x1, w.x2) && x <= Math.max(w.x1, w.x2) && y >= Math.min(w.y1, w.y2) && y <= Math.max(w.y1, w.y2);
}

const isEnd = (w: Wire, x: number, y: number) => (w.x1 === x && w.y1 === y) || (w.x2 === x && w.y2 === y);

/** A label's text as a SPICE node name. ngspice is case-insensitive and reports names in lower case. */
export function netName(text: string): string {
  const s = text.trim().toLowerCase().replace(/[^a-z0-9_+\-.]/g, '_');
  return s === 'gnd' ? '0' : s;
}

export function analysisLine(a: Analysis, parts: Part[], issues: Issue[]): string {
  const num = (text: string, what: string, positive = true): string => {
    const v = parseSI(text);
    if (v === null || (positive && !(v > 0))) { issues.push({ level: 'error', message: `Analysis: ${what} "${text}" is not a ${positive ? 'positive ' : ''}number` }); return '0'; }
    return toSpice(v);
  };
  switch (a.kind) {
    case 'tran': return `.tran ${num(a.step, 'time step')} ${num(a.stop, 'stop time')}`;
    case 'ac': return `.ac dec ${num(a.points, 'points per decade')} ${num(a.fstart, 'start frequency')} ${num(a.fstop, 'stop frequency')}`;
    case 'dc': {
      const src = parts.find((p) => (p.kind === 'V' || p.kind === 'I') && p.ref.toUpperCase() === a.source.trim().toUpperCase());
      if (!src) issues.push({ level: 'error', message: `DC sweep: there is no source called "${a.source}"` });
      return `.dc ${a.source.trim() || 'V1'} ${num(a.start, 'start value', false)} ${num(a.stop, 'stop value', false)} ${num(a.step, 'step')}`;
    }
    case 'op': return '.op';
  }
}

export function compile(sch: Schematic): Compiled {
  const issues: Issue[] = [];
  const uf = new UnionFind();
  const points = new Map<string, Point>();
  const touch = (x: number, y: number) => { const k = key(x, y); uf.add(k); points.set(k, { x, y }); return k; };

  const pins = sch.parts.flatMap((part) => pinPositions(part).map((pin) => ({ part, pin, k: touch(pin.x, pin.y) })));
  for (const w of sch.wires) uf.union(touch(w.x1, w.y1), touch(w.x2, w.y2));
  for (const w of sch.wires) for (const [k, p] of points) if (onWire(w, p.x, p.y)) uf.union(k, key(w.x1, w.y1));

  // Same-name labels join, and every ground symbol is the one node "0".
  const named = new Map<string, string>();
  for (const { part, k } of pins) {
    const name = part.kind === 'GND' ? '0' : part.kind === 'LABEL' ? netName(part.value) : null;
    if (name === null) continue;
    if (!name) { issues.push({ level: 'error', message: 'A net label has no name', partId: part.id }); continue; }
    if (named.has(name)) uf.union(k, named.get(name)!); else named.set(name, k);
  }
  const rootName = new Map<string, string>();
  for (const [name, k] of named) {
    const root = uf.find(k);
    const had = rootName.get(root);
    if (had === undefined || name === '0') rootName.set(root, name);
    if (had !== undefined && had !== name && had !== '0' && name !== '0') issues.push({ level: 'warning', message: `Labels "${had}" and "${name}" are on the same net; using "${rootName.get(root)}"` });
  }
  const taken = new Set(rootName.values());
  let auto = 0;
  const sorted = [...points.entries()].sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  for (const [k] of sorted) {
    const root = uf.find(k);
    if (rootName.has(root)) continue;
    let name: string;
    do name = `n${++auto}`; while (taken.has(name));
    rootName.set(root, name);
  }
  const nodeAt = (k: string) => rootName.get(uf.find(k))!;

  const pinNode = new Map<string, string>();
  for (const { part, pin, k } of pins) pinNode.set(`${part.id}:${pin.name}`, nodeAt(k));
  const wireNode = new Map(sch.wires.map((w) => [w.id, nodeAt(key(w.x1, w.y1))] as const));

  // Electrical rule checks: catch here what ngspice would report as a singular matrix.
  const devices = sch.parts.filter((p) => SYMBOLS[p.kind].card);
  if (devices.length === 0) issues.push({ level: 'error', message: 'Nothing to simulate yet: place some parts' });
  else if (!taken.has('0')) issues.push({ level: 'error', message: 'No ground. Place a ground symbol: SPICE measures every voltage from node 0' });

  const refs = new Map<string, Part>();
  for (const p of devices) {
    const ref = p.ref.toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) issues.push({ level: 'error', message: `"${p.ref}" is not a valid reference`, partId: p.id });
    else if (!ref.startsWith(SYMBOLS[p.kind].prefix)) issues.push({ level: 'error', message: `${p.ref}: a ${SYMBOLS[p.kind].label.toLowerCase()} reference must start with ${SYMBOLS[p.kind].prefix}`, partId: p.id });
    if (refs.has(ref)) issues.push({ level: 'error', message: `Two parts are called ${p.ref}`, partId: p.id });
    refs.set(ref, p);
    if (!p.value.trim()) issues.push({ level: 'error', message: `${p.ref} has no value`, partId: p.id });
    else if (p.kind === 'R' || p.kind === 'C' || p.kind === 'L') {
      const v = parseSI(p.value);
      if (v === null && !/[{}]/.test(p.value)) issues.push({ level: 'error', message: `${p.ref}: "${p.value}" is not a number`, partId: p.id });
      else if (v !== null && !(v > 0)) issues.push({ level: 'error', message: `${p.ref}: value must be greater than zero`, partId: p.id });
    }
  }

  const devicePinsOnNode = new Map<string, number>();
  for (const { part, k } of pins) if (SYMBOLS[part.kind].card) devicePinsOnNode.set(nodeAt(k), (devicePinsOnNode.get(nodeAt(k)) ?? 0) + 1);
  for (const { part, pin, k } of pins) {
    if (!SYMBOLS[part.kind].card) continue;
    const node = nodeAt(k);
    if (node !== '0' && devicePinsOnNode.get(node) === 1) {
      issues.push({ level: 'error', message: `${part.ref} pin ${pin.name} is not connected to anything`, partId: part.id, at: { x: pin.x, y: pin.y } });
    }
  }

  if (sch.analysis.kind === 'ac' && !devices.some((p) => (p.kind === 'V' || p.kind === 'I') && /\bac\b/i.test(p.value))) {
    issues.push({ level: 'warning', message: 'AC analysis needs a source with an AC magnitude: set a source value to "AC 1"' });
  }

  const junctions: Point[] = [];
  for (const [k, p] of points) {
    let degree = pins.filter((q) => q.k === k && q.part.kind !== 'LABEL').length;
    for (const w of sch.wires) if (onWire(w, p.x, p.y)) degree += isEnd(w, p.x, p.y) ? 1 : 2;
    if (degree >= 3) junctions.push(p);
  }

  const lines = [`* ${sch.title.replace(/\s+/g, ' ').trim() || 'untitled'}`];
  const models = new Set<string>();
  for (const p of devices) {
    const def = SYMBOLS[p.kind];
    const clean = { ...p, ref: p.ref.toUpperCase(), value: p.value.replace(/[\r\n]+/g, ' ') };
    lines.push(def.card!(clean, def.pins.map((pin) => pinNode.get(`${p.id}:${pin.name}`)!)));
    const m = MODELS[p.value.trim().toUpperCase()];
    if (m && def.valueLabel === 'Model') models.add(m);
  }
  lines.push(...models);
  const extra = sch.directives.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\.end$/i.test(l));
  lines.push(...extra);
  // Per-device currents (I(R1) and friends). ngspice cannot save them in AC analysis.
  if (sch.analysis.kind !== 'ac') lines.push('.options savecurrents');
  lines.push(analysisLine(sch.analysis, sch.parts, issues), '.end');

  return {
    netlist: lines.join('\n') + '\n',
    issues,
    ok: !issues.some((i) => i.level === 'error'),
    pinNode,
    wireNode,
    nodes: [...new Set(rootName.values())],
    junctions,
  };
}
