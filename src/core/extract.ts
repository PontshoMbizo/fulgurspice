// "Make subcircuit from selection": move the selected parts and wires into a new
// definition and put an instance where they were.
//
// Every net that runs both inside the selection and outside it becomes a port, wired
// to the instance pin. Ground is global in SPICE, so a ground net that crosses the
// boundary gets a ground symbol on each side instead of a port. A net that crosses only
// by name (labels) gets a label at the instance pin. Afterwards the outside connectivity
// is checked against the original: if the move would join or split any outside net, it
// is refused rather than done wrongly.

import { pointKey, newId, route } from './geometry';
import { compile, onWire } from './netlist';
import { subcktPorts, sheetOf, withSheet } from './subckt';
import { nextRef, partBox, pinPositions } from './symbols';
import type { Part, Point, Schematic, Wire } from './types';

export type ExtractResult = { ok: true; sch: Schematic; instanceId: string; ports: string[] } | { ok: false; error: string };

const fail = (error: string): ExtractResult => ({ ok: false, error });

type Seg = { x1: number; y1: number; x2: number; y2: number };

/** y first, then x: the other one-bend route, for when x-then-y would run through something. */
function routeYFirst(a: Point, b: Point): Seg[] {
  return [{ x1: a.x, y1: a.y, x2: a.x, y2: b.y }, { x1: a.x, y1: b.y, x2: b.x, y2: b.y }].filter((s) => s.x1 !== s.x2 || s.y1 !== s.y2);
}

export function makeSubckt(sch: Schematic, editing: string | null, ids: Set<string>, name: string): ExtractResult {
  const sheet = sheetOf(sch, editing);
  const selParts = sheet.parts.filter((p) => ids.has(p.id));
  const selWires = sheet.wires.filter((w) => ids.has(w.id));
  const outParts = sheet.parts.filter((p) => !ids.has(p.id));
  const outWires = sheet.wires.filter((w) => !ids.has(w.id));

  if (!selParts.length && !selWires.length) return fail('Select the parts to turn into a subcircuit first');
  if (!selParts.some((p) => p.kind !== 'LABEL' && p.kind !== 'GND' && p.kind !== 'PORT')) return fail('Select at least one real part, not only wires and labels');
  if (selParts.some((p) => p.kind === 'PORT')) return fail('Subcircuit ports belong to the subcircuit you are editing: deselect them');

  const view = compile(sch, editing === null ? {} : { sheet: editing });
  const nodeOfPin = (p: Part, pin: string) => view.pinNode.get(`${p.id}:${pin}`)!;

  // Which net each point belongs to, and which points the two sides have.
  type Pt = Point & { node: string };
  const ptsOf = (parts: Part[], wires: Wire[]): Pt[] => [
    ...parts.flatMap((p) => pinPositions(p).map((pin) => ({ x: pin.x, y: pin.y, node: nodeOfPin(p, pin.name) }))),
    ...wires.flatMap((w) => { const node = view.wireNode.get(w.id)!; return [{ x: w.x1, y: w.y1, node }, { x: w.x2, y: w.y2, node }]; }),
  ];
  const inPts = ptsOf(selParts, selWires), outPts = ptsOf(outParts, outWires);
  const inNets = new Set([...inPts.map((p) => p.node), ...selWires.map((w) => view.wireNode.get(w.id)!)]);
  const outNets = new Set([...outPts.map((p) => p.node), ...outWires.map((w) => view.wireNode.get(w.id)!)]);
  const crossing = [...inNets].filter((n) => outNets.has(n));

  // Boundary points: where the two sides physically meet.
  const onGeometry = (q: Point, parts: Part[], wires: Wire[]) =>
    parts.some((p) => pinPositions(p).some((pin) => pin.x === q.x && pin.y === q.y)) || wires.some((w) => onWire(w, q.x, q.y));
  const boundary = new Map<string, Pt>();
  for (const q of outPts) if (onGeometry(q, selParts, selWires)) boundary.set(pointKey(q.x, q.y), q);
  for (const p of inPts) if (onGeometry(p, outParts, outWires)) boundary.set(pointKey(p.x, p.y), p);
  const boundaryOf = (node: string) => [...boundary.values()].filter((q) => q.node === node).sort((a, b) => a.x - b.x || a.y - b.y);

  // Ports: every crossing net but ground. Names come from labels where there are any.
  const taken = new Set(view.nodes);
  let k = 0;
  const portFor = (node: string) => {
    if (!/^n\d+$/.test(node)) return node;
    let n: string;
    do n = `p${++k}`; while (taken.has(n));
    taken.add(n);
    return n;
  };
  const anchorOf = (node: string): Point => {
    const b = boundaryOf(node)[0];
    if (b) return b;
    const own = inPts.filter((q) => q.node === node).sort((a, c) => a.x - c.x || a.y - c.y)[0];
    return own;
  };
  const nets = crossing.filter((n) => n !== '0').map((node) => ({ node, port: portFor(node), anchor: anchorOf(node) }))
    .sort((a, b) => a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);
  const ports = nets.map((n) => n.port);
  if (!nets.length && !crossing.includes('0')) return fail('That selection is not connected to the rest of the circuit, so there is nothing to make a subcircuit of');

  // Where the instance goes: the middle of what it replaces.
  const xs: number[] = [], ys: number[] = [];
  for (const p of selParts) { const b = partBox(p); xs.push(b.x0, b.x1); ys.push(b.y0, b.y1); }
  for (const w of selWires) { xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); }
  const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2), cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  const instance: Part = { id: newId(), kind: 'SUBCKT', ref: nextRef(outParts, 'X'), x: cx, y: cy, rot: 0, mirror: false, value: name, ports };
  const pins = pinPositions(instance);

  // Inside: the selection, plus a port (or ground symbol) where each crossing net meets the boundary.
  const mk = (kind: Part['kind'], x: number, y: number, value: string): Part => ({ id: newId(), kind, ref: '', x, y, rot: 0, mirror: false, value });
  const innerExtra: Part[] = [];
  const outerExtra: Part[] = [];
  const newWires: Wire[] = [];
  nets.forEach((n, i) => {
    innerExtra.push(mk('PORT', n.anchor.x, n.anchor.y, n.port));
    const pin = pins[i], spots = boundaryOf(n.node);
    if (!spots.length) { outerExtra.push(mk('LABEL', pin.x, pin.y, n.node)); return; } // joined by name only
    for (const q of spots) {
      const candidates = [route(pin, q), routeYFirst(pin, q)];
      const touchesForeign = (segs: Seg[]) => segs.some((sg) => outPts.some((o) => o.node !== n.node && !(o.x === q.x && o.y === q.y) && onWire({ id: '', ...sg }, o.x, o.y)));
      const segs = candidates.find((c) => !touchesForeign(c)) ?? candidates[0];
      for (const sg of segs) newWires.push({ id: newId(), ...sg });
    }
  });
  if (crossing.includes('0')) {
    for (const q of boundaryOf('0')) {
      if (!selParts.some((p) => p.kind === 'GND' && pinPositions(p).some((pin) => pin.x === q.x && pin.y === q.y))) innerExtra.push(mk('GND', q.x, q.y, ''));
      if (!outParts.some((p) => p.kind === 'GND' && pinPositions(p).some((pin) => pin.x === q.x && pin.y === q.y))) outerExtra.push(mk('GND', q.x, q.y, ''));
    }
  }

  const def = { name, parts: [...selParts, ...innerExtra], wires: selWires };
  const withDef: Schematic = { ...sch, subckts: [...sch.subckts, def] };
  const next = withSheet(withDef, editing, { ...sheetOf(withDef, editing), parts: [...outParts, instance, ...outerExtra], wires: [...outWires, ...newWires] });

  // Safety net: the outside must wire up exactly as before. Compare which of the
  // remaining parts' pins share a net, ignoring what the nets are called.
  const after = compile(next, editing === null ? {} : { sheet: editing });
  const groups = (pinNode: Map<string, string>) => {
    const by = new Map<string, string[]>();
    for (const p of outParts) for (const pin of pinPositions(p)) { const key = `${p.id}:${pin.name}`; const node = pinNode.get(key)!; by.set(node, [...(by.get(node) ?? []), key]); }
    return [...by.values()].map((g) => g.sort().join('|')).sort().join('\n');
  };
  if (groups(view.pinNode) !== groups(after.pinNode)) return fail('Making that a subcircuit would join or split nets outside it (a connection runs where the wires cannot be routed cleanly). Move the selection so its connections come out straight, or select a bit more');
  if (subcktPorts(def).length !== ports.length) return fail('Internal error: port list mismatch');

  return { ok: true, sch: next, instanceId: instance.id, ports };
}
