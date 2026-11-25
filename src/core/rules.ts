// Topology rule checks: the circuits SPICE cannot solve, caught before ngspice
// sees them and explained in circuit terms rather than as "singular matrix".
//
// Pure: it works on an abstract list of devices (which node each pin sits on), so
// it needs no schematic, no DOM and no engine. `compile()` feeds it.

import type { PartKind } from './types';

export interface Device {
  partId: string;
  ref: string;
  kind: PartKind;
  /** pin name -> node name, as in the symbol table */
  nodes: Record<string, string>;
  /** Behavioural source only: true for I=..., false for V=... */
  current?: boolean;
}

export interface Finding {
  level: 'error' | 'warning';
  message: string;
  partId?: string;
}

type Edge = [string, string];

/** Branches whose voltage is fixed by the element itself: an ideal source of any kind, or an
 * inductor (a wire at DC). */
function voltageEdges(d: Device): Edge[] {
  const n = d.nodes;
  switch (d.kind) {
    case 'V': return [[n['+'], n['-']]];
    case 'L': return [[n['1'], n['2']]];
    case 'XFMR': return [[n['P1'], n['P2']], [n['S1'], n['S2']]];
    case 'VCVS': case 'CCVS': return [[n['O+'], n['O-']]];
    case 'BSRC': return d.current ? [] : [[n['+'], n['-']]];
    case 'OPAMP': case 'OPAMPS': return [[n['out'], '0']];
    default: return [];
  }
}

const isInductive = (d: Device) => d.kind === 'L' || d.kind === 'XFMR';

/** The two nodes an ideal current source pushes current between, or null if the part is not one. */
function currentSourceNodes(d: Device): Edge | null {
  const n = d.nodes;
  switch (d.kind) {
    case 'I': return [n['+'], n['-']];
    case 'VCCS': case 'CCCS': return [n['O+'], n['O-']];
    case 'BSRC': return d.current ? [n['+'], n['-']] : null;
    default: return null;
  }
}

/** Where DC current can flow through the element (capacitors, gates and ideal
 * current sources do not conduct, so they are absent). */
function conductEdges(d: Device): Edge[] {
  const n = d.nodes;
  switch (d.kind) {
    case 'R': return [[n['1'], n['2']]];
    case 'V': case 'L': case 'XFMR': case 'VCVS': case 'CCVS': case 'BSRC': case 'OPAMP': case 'OPAMPS': return voltageEdges(d);
    case 'D': case 'ZENER': case 'LED': return [[n['A'], n['K']]];
    case 'NPN': case 'PNP': return [[n['C'], n['E']], [n['B'], n['E']]];
    case 'NMOS': case 'PMOS': return [[n['D'], n['S']]];
    case 'POT': return [[n['1'], n['W']], [n['W'], n['2']]];
    // An open switch still has its off-resistance, so it never leaves a net floating on its own.
    case 'SW': case 'VSW': return [[n['1'], n['2']]];
    // Unknown inside: assume it conducts between its pins, so it never causes a false alarm.
    case 'SUBCKT': { const v = Object.values(n); return v.slice(1).map((x): Edge => [v[0], x]); }
    default: return [];
  }
}

/** Where *any* current (DC or not) can flow: conduction plus capacitors. Used for
 * the current-source cut-set, where only ideal current sources are excluded. */
function currentEdges(d: Device): Edge[] {
  return d.kind === 'C' ? [[d.nodes['1'], d.nodes['2']]] : conductEdges(d);
}

class Groups {
  private parent = new Map<string, string>();
  find(a: string): string {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let r = a;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = a;
    while (c !== r) { const next = this.parent.get(c)!; this.parent.set(c, r); c = next; }
    return r;
  }
  union(a: string, b: string) { this.parent.set(this.find(a), this.find(b)); }
  same(a: string, b: string) { return this.find(a) === this.find(b); }
}

const list = (names: string[]) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

export function topologyFindings(devices: Device[], opts: { loopsOnly?: boolean } = {}): Finding[] {
  const out: Finding[] = [];

  // 1. Loops of ideal voltage branches. Measured against ngspice: a loop of sources alone has
  //    no solution (error). A loop that includes an inductor has no unique DC solution, but
  //    ngspice recovers with a transient start and transient and AC results are right, so that
  //    is a warning.
  interface VEdge { a: string; b: string; dev: Device }
  const vedges: VEdge[] = devices.flatMap((d) => voltageEdges(d).map(([a, b]) => ({ a, b, dev: d })));
  const sources = vedges.filter((e) => !isInductive(e.dev)), coils = vedges.filter((e) => isInductive(e.dev));
  const vloop = new Groups();
  const adj = new Map<string, { to: string; e: VEdge }[]>();
  const link = (e: VEdge) => {
    for (const [x, y] of [[e.a, e.b], [e.b, e.a]] as const) adj.set(x, [...(adj.get(x) ?? []), { to: y, e }]);
  };
  for (const e of sources) {
    if (e.a === e.b) out.push({ level: 'error', partId: e.dev.partId, message: `${e.dev.ref} is shorted: both of its pins are on net ${e.a}. A source across a single net has no solution` });
    else if (vloop.same(e.a, e.b)) out.push({ level: 'error', partId: e.dev.partId, message: `${e.dev.ref} closes a loop made only of voltage sources (nets ${e.a} and ${e.b} are already tied together by ideal sources). Kirchhoff's voltage law cannot hold: put a resistor in the loop` });
    else { vloop.union(e.a, e.b); link(e); }
  }
  const pathBetween = (from: string, to: string): VEdge[] | null => {
    const prev = new Map<string, { from: string; e: VEdge } | null>([[from, null]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      if (node === to) break;
      for (const { to: next, e } of adj.get(node) ?? []) if (!prev.has(next)) { prev.set(next, { from: node, e }); queue.push(next); }
    }
    if (!prev.has(to)) return null;
    const path: VEdge[] = [];
    for (let at = to; prev.get(at); at = prev.get(at)!.from) path.push(prev.get(at)!.e);
    return path;
  };
  for (const e of coils) {
    const path = e.a === e.b ? [] : pathBetween(e.a, e.b);
    if (e.a !== e.b && !path) { link(e); continue; }
    const members = [...new Set([e.dev.ref, ...(path ?? []).map((x) => x.dev.ref)])];
    out.push({ level: 'warning', partId: e.dev.partId, message: `${e.dev.ref} forms a loop with ideal voltage sources${members.length > 1 ? ` (${members.join(', ')})` : ''}. At DC an inductor is a short, so the operating point is undefined and ngspice falls back to a transient start. Transient and AC results are fine, but a DC operating point is not meaningful: add a small series resistor for a clean start` });
  }

  if (opts.loopsOnly) return out;

  // 2. Current-source cut-set: a part of the circuit joined to the rest only through
  //    ideal current sources. The currents must sum to zero or KCL fails.
  const isrc = devices.filter((d) => currentSourceNodes(d) !== null);
  const flow = new Groups();
  for (const d of devices) for (const [a, b] of currentEdges(d)) flow.union(a, b);
  const cut = new Set<string>();
  const stranded = new Map<string, Device[]>();
  for (const d of isrc) {
    const [a, b] = currentSourceNodes(d)!;
    if (flow.same(a, b)) continue; // both ends are in one lump: not a cut
    for (const end of [a, b]) {
      const root = flow.find(end);
      if (flow.same(end, '0')) continue;
      stranded.set(root, [...(stranded.get(root) ?? []), d]);
    }
  }
  for (const [root, sources] of stranded) {
    cut.add(root);
    const refs = [...new Set(sources.map((s) => s.ref))];
    out.push({ level: 'error', partId: sources[0].partId, message: `${list(refs)} ${refs.length === 1 ? 'pushes' : 'push'} current into part of the circuit that has no other way back to ground. Kirchhoff's current law cannot hold: give the current a path, for example a resistor` });
  }

  // 3. No DC path to ground. Not fatal (ngspice adds a tiny leakage, gmin, and
  //    carries on) but the operating point is then arbitrary, so say so.
  const dc = new Groups();
  for (const d of devices) for (const [a, b] of conductEdges(d)) dc.union(a, b);
  const seen = new Set<string>();
  const nets = [...new Set(devices.flatMap((d) => Object.values(d.nodes)))];
  for (const net of nets) {
    if (net === '0' || dc.same(net, '0')) continue;
    const root = dc.find(net);
    if (seen.has(root) || cut.has(flow.find(net))) continue;
    seen.add(root);
    const group = nets.filter((m) => dc.find(m) === root);
    const touching = devices.filter((d) => Object.values(d.nodes).some((m) => dc.find(m) === root));
    const NAMES: Partial<Record<PartKind, string>> = { C: 'capacitors', I: 'current sources', NMOS: 'MOSFET gates', PMOS: 'MOSFET gates', OPAMP: 'op-amp inputs' };
    const names = [...new Set(touching.map((d) => NAMES[d.kind]).filter((v): v is string => !!v))];
    const why = names.length ? ` (only ${names.join(', ')} touch it)` : '';
    out.push({ level: 'warning', partId: touching[0]?.partId, message: `Net ${list(group)} has no DC path to ground${why}. Its DC voltage is undefined: add a resistor to ground, or ngspice will guess` });
  }
  return out;
}
