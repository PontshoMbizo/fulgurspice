// Schematic -> SPICE netlist. The netlist text is the only thing the engine ever
// sees, so the same output runs in the browser (ngspice-wasm), on a server, or in
// desktop ngspice when a result needs a second opinion.
//
// Connectivity rule: a pin or wire end that lies anywhere on a wire is connected
// to it. Two wires that merely cross are not.

import type { Analysis, Part, Point, Schematic, Subckt, Wire } from './types';
import { pointKey } from './geometry';
import { topologyFindings, type Device } from './rules';
import { dotParamNames, exprNames, formatParams, parseParams, parseSweep } from './params';
import { subcktPorts } from './subckt';
import { DIGIT_LETTER_DIGIT, parseBehavioural, referencedNets } from './valuespec';
import { MODELS, SUBCKT_NAME, pinPositions, symbolFor } from './symbols';
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

export interface CompileOptions {
  /** Compile this subcircuit's own sheet (for editing it) instead of the top sheet. */
  sheet?: string;
  /** With `sheet`: build a runnable netlist from that sheet on its own, test bench parts and all. */
  standalone?: boolean;
  /** The value the sweep parameter takes in this netlist (default: the first of the sweep). */
  sweepValue?: string;
}

/** top: the document's main sheet. sub: a definition as emitted (test bench left out).
 * view: a definition as drawn, for editing. standalone: a definition run as a circuit. */
type Mode = 'top' | 'sub' | 'view' | 'standalone';

interface Sheet { parts: Part[]; wires: Wire[] }

interface SheetOut {
  pinNode: Map<string, string>;
  wireNode: Map<string, string>;
  nodes: string[];
  junctions: Point[];
  issues: Issue[];
  /** One SPICE card per device on the sheet. */
  cards: string[];
  models: Set<string>;
  /** Node names of the PORT parts, in order (subcircuit sheets). */
  portNodes: string[];
}

/** Turn one sheet (the top one, or a subcircuit's) into nodes, checks and cards. */
function analyseSheet(sheetIn: Sheet, mode: Mode, defs: Map<string, Subckt>, scope: Set<string>): SheetOut {
  const sub = mode === 'sub' || mode === 'view'; // ports mean something, and there is no ground of its own
  const sheet: Sheet = mode === 'sub' ? { ...sheetIn, parts: sheetIn.parts.filter((p) => !p.bench) } : sheetIn;
  const issues: Issue[] = [];
  const uf = new UnionFind();
  const points = new Map<string, Point>();
  const touch = (x: number, y: number) => { const k = pointKey(x, y); uf.add(k); points.set(k, { x, y }); return k; };

  const pins = sheet.parts.flatMap((part) => pinPositions(part).map((pin) => ({ part, pin, k: touch(pin.x, pin.y) })));
  for (const w of sheet.wires) uf.union(touch(w.x1, w.y1), touch(w.x2, w.y2));
  for (const w of sheet.wires) for (const [k, p] of points) if (onWire(w, p.x, p.y)) uf.union(k, pointKey(w.x1, w.y1));

  // Same-name labels join, and every ground symbol is the one node "0". On a
  // subcircuit sheet a port is a label too: its name is what the outside sees.
  const named = new Map<string, string>();
  const portKeys: { part: Part; k: string; name: string }[] = [];
  for (const { part, k } of pins) {
    const isPort = part.kind === 'PORT';
    const name = part.kind === 'GND' ? '0' : part.kind === 'LABEL' || isPort ? netName(part.value) : null;
    if (name === null) continue;
    if (isPort) {
      if (mode === 'top') { issues.push({ level: 'warning', message: `Port "${part.value}" is only meaningful inside a subcircuit: it does nothing here`, partId: part.id }); continue; }
      if (!name) { issues.push({ level: 'error', message: 'A port has no name', partId: part.id }); continue; }
      if (sub) {
        if (name === '0') { issues.push({ level: 'error', message: 'A port cannot be called ground: ground is already shared with the outside', partId: part.id }); continue; }
        portKeys.push({ part, k, name });
      } // standalone: the port is just a named net, like a label
    }
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
  const wireNode = new Map(sheet.wires.map((w) => [w.id, nodeAt(pointKey(w.x1, w.y1))] as const));

  // Electrical rule checks: catch here what ngspice would report as a singular matrix.
  const devices = sheet.parts.filter((p) => symbolFor(p).card);
  if (!sub) {
    if (devices.length === 0) issues.push({ level: 'error', message: 'Nothing to simulate yet: place some parts' });
    else if (!taken.has('0')) issues.push({ level: 'error', message: 'No ground. Place a ground symbol: SPICE measures every voltage from node 0' });
  }

  const refs = new Map<string, Part>();
  // What a behavioural expression may refer to: the nets and voltage sources of this sheet.
  const exprScope = { nets: new Set([...rootName.values()].map((n) => n.toLowerCase())), vsources: new Set(sheet.parts.filter((q) => q.kind === 'V').map((q) => q.ref.toLowerCase())) };
  for (const p of devices) {
    const def = symbolFor(p);
    const ref = p.ref.toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) issues.push({ level: 'error', message: `"${p.ref}" is not a valid reference`, partId: p.id });
    else if (!ref.startsWith(def.prefix)) issues.push({ level: 'error', message: `${p.ref}: a ${def.label.toLowerCase()} reference must start with ${def.prefix}`, partId: p.id });
    if (refs.has(ref)) issues.push({ level: 'error', message: `Two parts are called ${p.ref}`, partId: p.id });
    refs.set(ref, p);
    // An undefined {name} makes ngspice spin forever, so refuse it here, where the cause can be named.
    const unknown = exprNames(p.value).filter((n) => !scope.has(n));
    if (unknown.length) issues.push({ level: 'error', message: `${p.ref}: ${p.value.trim()} uses ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not defined. Add ${unknown.length === 1 ? 'it' : 'them'} as subcircuit parameters, or with .param in the SPICE directives`, partId: p.id });
    const why = def.check?.(p, { parts: sheet.parts, scope: exprScope });
    if (why) issues.push({ level: 'error', message: why, partId: p.id });
    // ngspice reads 4k7 as 4k without a word (LTspice habit), so refuse it in free-text source values.
    if ((p.kind === 'V' || p.kind === 'I') && DIGIT_LETTER_DIGIT.test(` ${p.value}`)) issues.push({ level: 'error', message: `${p.ref}: "${p.value.trim()}" has a number written like 4k7, which ngspice reads as 4k. Write 4.7k`, partId: p.id });
    if (!p.value.trim()) issues.push({ level: 'error', message: `${p.ref} has no value`, partId: p.id });
    else if (p.kind === 'R' || p.kind === 'C' || p.kind === 'L') {
      const v = parseSI(p.value);
      if (v === null && !/[{}]/.test(p.value)) issues.push({ level: 'error', message: `${p.ref}: "${p.value}" is not a number`, partId: p.id });
      else if (v !== null && !(v > 0)) issues.push({ level: 'error', message: `${p.ref}: value must be greater than zero`, partId: p.id });
    } else if (p.kind === 'SUBCKT' && p.value.trim()) {
      if (!SUBCKT_NAME.test(p.value.trim())) issues.push({ level: 'error', message: `${p.ref}: "${p.value}" is not a valid subcircuit name`, partId: p.id });
      else {
        const def = defs.get(p.value.trim().toLowerCase());
        if (!def) issues.push({ level: 'error', message: `${p.ref}: there is no subcircuit called "${p.value.trim()}"`, partId: p.id });
        else {
          // ngspice ignores an unknown parameter without a word, so a typo would silently do nothing.
          const given = parseParams(p.params), known = parseParams(def.params).items.map((q) => q.name);
          const free = given.items.flatMap((q) => exprNames(q.value)).filter((n) => !scope.has(n));
          if (given.error) issues.push({ level: 'error', message: `${p.ref}: ${given.error}`, partId: p.id });
          else if (free.length) issues.push({ level: 'error', message: `${p.ref}: parameters use ${[...new Set(free)].join(', ')}, which is not defined here`, partId: p.id });
          else for (const q of given.items) if (!known.some((k) => k.toLowerCase() === q.name.toLowerCase())) issues.push({ level: 'error', message: `${p.ref}: ${def.name} has no parameter "${q.name}"${known.length ? ` (it has ${known.join(', ')})` : ' (it has none)'}`, partId: p.id });
        }
      }
    }
  }

  const devicePinsOnNode = new Map<string, number>();
  for (const { part, k } of pins) if (symbolFor(part).card) devicePinsOnNode.set(nodeAt(k), (devicePinsOnNode.get(nodeAt(k)) ?? 0) + 1);
  // A behavioural source reads nets by name, which uses them as much as a pin does.
  const readNets = new Set(devices.filter((p) => p.kind === 'BSRC').flatMap((p) => { const r = parseBehavioural(p.value); return r.ok ? referencedNets(r.expr) : []; }));
  // A port's net continues outside the subcircuit, so a pin that only meets a port is not dangling.
  const portNets = new Set(portKeys.map((q) => nodeAt(q.k)));
  let dangling = false;
  for (const { part, pin, k } of pins) {
    if (!symbolFor(part).card) continue;
    const node = nodeAt(k);
    if (node !== '0' && !portNets.has(node) && !readNets.has(node.toLowerCase()) && devicePinsOnNode.get(node) === 1) {
      dangling = true;
      issues.push({ level: 'error', message: `${part.ref} pin ${pin.name} is not connected to anything`, partId: part.id, at: { x: pin.x, y: pin.y } });
    }
  }

  if (sub) {
    const seen = new Set<string>();
    for (const { part, name } of portKeys) {
      if (seen.has(name)) issues.push({ level: 'error', message: `Two ports are called "${part.value.trim()}"`, partId: part.id });
      seen.add(name);
      if (!devicePinsOnNode.get(name)) issues.push({ level: 'warning', message: `Port "${part.value.trim()}" is not connected to anything inside the subcircuit`, partId: part.id });
    }
  }

  // Loops and cut-sets only make sense on a fully connected circuit with a ground;
  // otherwise they would just repeat the dangling-pin errors in other words. A
  // subcircuit has no ground of its own, so only the voltage-loop check applies.
  if (!dangling && (sub || taken.has('0'))) {
    const topo: Device[] = devices.map((p) => ({
      partId: p.id, ref: p.ref, kind: p.kind, current: p.kind === 'BSRC' && /^\s*i\s*=/i.test(p.value),
      nodes: Object.fromEntries(symbolFor(p).pins.map((pin) => [pin.name, pinNode.get(`${p.id}:${pin.name}`)!])),
    }));
    issues.push(...topologyFindings(topo, { loopsOnly: sub }));
  }

  const junctions: Point[] = [];
  for (const [k, p] of points) {
    let degree = pins.filter((q) => q.k === k && q.part.kind !== 'LABEL' && q.part.kind !== 'PORT').length;
    for (const w of sheet.wires) if (onWire(w, p.x, p.y)) degree += isEnd(w, p.x, p.y) ? 1 : 2;
    if (degree >= 3) junctions.push(p);
  }

  const cards: string[] = [];
  const models = new Set<string>();
  for (const p of devices) {
    const def = symbolFor(p);
    const clean = { ...p, ref: p.ref.toUpperCase(), value: p.value.replace(/[\r\n]+/g, ' ') };
    cards.push(def.card!(clean, pinPositions(p).map((pin) => pinNode.get(`${p.id}:${pin.name}`)!)));
    const m = MODELS[p.value.trim().toUpperCase()];
    if (m && def.valueLabel === 'Model') models.add(m);
  }

  return {
    pinNode, wireNode, nodes: [...new Set(rootName.values())], junctions, issues, cards, models,
    portNodes: portKeys.map((q) => q.name),
  };
}

const subcktBlock = (def: Subckt, out: SheetOut) => {
  const params = formatParams(parseParams(def.params).items);
  return [[`.subckt ${def.name}`, ...out.portNodes, params && `params: ${params}`].filter(Boolean).join(' '), ...out.cards, `.ends ${def.name}`];
};

/** Names of the subcircuits a sheet instantiates, in order of first use. */
const usedBy = (parts: Part[]) => [...new Set(parts.filter((p) => p.kind === 'SUBCKT').map((p) => p.value.trim().toLowerCase()))];

/** Problems with a definition's own parameter list. */
const paramIssues = (def: Subckt): Issue[] => {
  const { error } = parseParams(def.params);
  return error ? [{ level: 'error', message: `Parameters: ${error}` }] : [];
};

export function compile(sch: Schematic, opts: CompileOptions = {}): Compiled {
  const defs = new Map((sch.subckts ?? []).map((s) => [s.name.toLowerCase(), s]));
  const missing = (name: string): Compiled => ({ netlist: '', issues: [{ level: 'error', message: `There is no subcircuit called "${name}"` }], ok: false, pinNode: new Map(), wireNode: new Map(), nodes: [], junctions: [] });

  // One sheet as it is drawn, for the editor: its own nets and problems, the definition as its netlist.
  const viewDef = opts.sheet !== undefined && !opts.standalone ? defs.get(opts.sheet.toLowerCase()) : undefined;
  if (opts.sheet !== undefined && !opts.standalone) {
    if (!viewDef) return missing(opts.sheet);
    const scopeOf = new Set([...dotParamNames(sch.directives), ...parseParams(viewDef.params).items.map((q) => q.name.toLowerCase())]);
    const drawn = analyseSheet(viewDef, 'view', defs, scopeOf);
    const emitted = analyseSheet(viewDef, 'sub', defs, scopeOf);
    drawn.issues.push(...paramIssues(viewDef));
    if (!SUBCKT_NAME.test(viewDef.name)) drawn.issues.push({ level: 'error', message: `"${viewDef.name}" is not a valid subcircuit name` });
    if (!subcktPorts(viewDef).length) drawn.issues.push({ level: 'warning', message: 'This subcircuit has no ports yet: place Subcircuit port parts to give it connections' });
    return { netlist: subcktBlock(viewDef, emitted).join('\n') + '\n', issues: drawn.issues, ok: !drawn.issues.some((i) => i.level === 'error'), pinNode: drawn.pinNode, wireNode: drawn.wireNode, nodes: drawn.nodes, junctions: drawn.junctions };
  }

  // The main sheet: the document's, or (standalone) a subcircuit's own, run as a circuit.
  const standaloneDef = opts.standalone && opts.sheet !== undefined ? defs.get(opts.sheet.toLowerCase()) : undefined;
  if (opts.standalone && opts.sheet !== undefined && !standaloneDef) return missing(opts.sheet);
  const mainParts = standaloneDef ? standaloneDef.parts : sch.parts;
  const sw = parseSweep(sch.sweep);
  // The sweep parameter is defined by the sweep itself, so {name} in a value is not "undefined".
  const globals = [...dotParamNames(sch.directives), ...(sw.sweep ? [sw.sweep.param.toLowerCase()] : [])];
  const ownParams = standaloneDef ? parseParams(standaloneDef.params).items : [];
  const top = analyseSheet(standaloneDef ?? sch, standaloneDef ? 'standalone' : 'top', defs, new Set([...globals, ...ownParams.map((q) => q.name.toLowerCase())]));
  const issues = top.issues;
  if (standaloneDef) issues.push(...paramIssues(standaloneDef));
  if (sw.error) issues.push({ level: 'error', message: `Sweep: ${sw.error}` });
  if (sw.sweep && dotParamNames(sch.directives).includes(sw.sweep.param.toLowerCase())) issues.push({ level: 'warning', message: `${sw.sweep.param} is set both in the SPICE directives and by the sweep: the sweep value is used` });
  const models = new Set(top.models);

  // Every subcircuit reachable from the main sheet, checked and emitted once.
  const order: Subckt[] = [];
  const visiting: string[] = [];
  const visit = (key: string) => {
    const def = defs.get(key);
    if (!def || order.includes(def)) return;
    if (visiting.includes(key)) { issues.push({ level: 'error', message: `Subcircuit ${def.name} contains itself (${[...visiting.slice(visiting.indexOf(key)), key].map((k) => defs.get(k)?.name ?? k).join(' → ')}): a subcircuit cannot be placed inside its own sheet` }); return; }
    visiting.push(key);
    for (const next of usedBy(def.parts.filter((p) => !p.bench))) visit(next);
    visiting.pop();
    order.push(def);
  };
  if (standaloneDef) visiting.push(standaloneDef.name.toLowerCase()); // it is on the stack: placing itself inside itself is recursion
  for (const key of usedBy(mainParts)) visit(key);

  const blocks: string[] = [];
  for (const def of order) {
    const out = analyseSheet(def, 'sub', defs, new Set([...globals, ...parseParams(def.params).items.map((q) => q.name.toLowerCase())]));
    for (const i of [...out.issues, ...paramIssues(def)]) issues.push({ level: i.level, message: `In subcircuit ${def.name}: ${i.message}` });
    if (!subcktPorts(def).length) issues.push({ level: 'warning', message: `Subcircuit ${def.name} has no ports` });
    blocks.push(...subcktBlock(def, out));
    for (const m of out.models) models.add(m);
  }

  const title = standaloneDef ? `${standaloneDef.name} on its own` : sch.title;
  // Run on its own, the sheet's parameter defaults have to exist at the top level.
  const paramLines = ownParams.map((q) => `.param ${q.name}=${q.value}`);
  const lines = [`* ${title.replace(/\s+/g, ' ').trim() || 'untitled'}`, ...paramLines, ...blocks, ...top.cards, ...models];
  const extra = sch.directives.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\.end$/i.test(l));
  lines.push(...extra);
  // After the user's own lines: when a parameter is set twice the last one wins (measured).
  if (sw.sweep) lines.push(`.param ${sw.sweep.param}=${opts.sweepValue ?? sw.sweep.values[0].value}`);
  // Per-device currents (I(R1) and friends). ngspice cannot save them in AC analysis.
  if (sch.analysis.kind !== 'ac') lines.push('.options savecurrents');
  lines.push(analysisLine(sch.analysis, mainParts, issues), '.end');

  return {
    netlist: lines.join('\n') + '\n',
    issues,
    ok: !issues.some((i) => i.level === 'error'),
    pinNode: top.pinNode,
    wireNode: top.wireNode,
    nodes: top.nodes,
    junctions: top.junctions,
  };
}
