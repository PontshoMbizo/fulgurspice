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
}

export interface Finding {
  level: 'error' | 'warning';
  message: string;
  partId?: string;
}

type Edge = [string, string];

/** Branches whose voltage is fixed by the element itself (an ideal source, or an
 * inductor, which is a wire at DC). Two of these around a loop contradict each other. */
function voltageEdges(d: Device): Edge[] {
  const n = d.nodes;
  switch (d.kind) {
    case 'V': return [[n['+'], n['-']]];
    case 'L': return [[n['1'], n['2']]];
    case 'OPAMP': return [[n['out'], '0']];
    default: return [];
  }
}

/** Where DC current can flow through the element (capacitors, gates and ideal
 * current sources do not conduct, so they are absent). */
function conductEdges(d: Device): Edge[] {
  const n = d.nodes;
  switch (d.kind) {
    case 'R': return [[n['1'], n['2']]];
    case 'V': case 'L': case 'OPAMP': return voltageEdges(d);
    case 'D': return [[n['A'], n['K']]];
    case 'NPN': case 'PNP': return [[n['C'], n['E']], [n['B'], n['E']]];
    case 'NMOS': case 'PMOS': return [[n['D'], n['S']]];
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

export function topologyFindings(devices: Device[]): Finding[] {
  const out: Finding[] = [];

  // 1. A loop made only of voltage sources and inductors: Kirchhoff's voltage law
  //    has no solution (or the currents in the loop are undetermined).
  const vloop = new Groups();
  for (const d of devices) {
    for (const [a, b] of voltageEdges(d)) {
      if (a === b) out.push({ level: 'error', partId: d.partId, message: `${d.ref} is shorted: both of its pins are on net ${a}. A source or inductor across a single net has no solution` });
      else if (vloop.same(a, b)) out.push({ level: 'error', partId: d.partId, message: `${d.ref} closes a loop made only of voltage sources and inductors (nets ${a} and ${b} are already tied together by ideal sources). Kirchhoff's voltage law cannot hold: put a resistor in the loop` });
      else vloop.union(a, b);
    }
  }

  // 2. Current-source cut-set: a part of the circuit joined to the rest only through
  //    ideal current sources. The currents must sum to zero or KCL fails.
  const isrc = devices.filter((d) => d.kind === 'I');
  const flow = new Groups();
  for (const d of devices) for (const [a, b] of currentEdges(d)) flow.union(a, b);
  const cut = new Set<string>();
  const stranded = new Map<string, Device[]>();
  for (const d of isrc) {
    const a = d.nodes['+'], b = d.nodes['-'];
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
