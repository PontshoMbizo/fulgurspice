import { describe, expect, it } from 'vitest';
import { formatSI, niceTicks, parseSI, spiceValue } from '../src/core/units';
import { compile } from '../src/core/netlist';
import { EXAMPLES } from '../src/core/examples';
import { emptySchematic, type Part, type Schematic } from '../src/core/types';
import { pinPositions, toWorld } from '../src/core/symbols';
import { topologyFindings, type Device } from '../src/core/rules';
import { vectorLabel } from '../src/sim/result';
import { addPart, addSubckt, copyItems, moveItems, normalizeAll, normalizeWires, parseSchematic, pasteItems, removeSubckt, removeWireSpan, sheetOf, subcktNameProblem, withSheet } from '../src/ui/store';
import { subcktPorts, syncInstances } from '../src/core/subckt';
import { pinPositions as pinsOf, subcktSymbol } from '../src/core/symbols';
import { withLabelOffset } from '../src/ui/SchematicCanvas';

const close = (a: number | null, b: number) => expect(Math.abs((a ?? NaN) - b)).toBeLessThan(Math.abs(b) * 1e-9 + 1e-30);

describe('units', () => {
  it('parses SPICE suffixes, where m is milli and meg is mega', () => {
    close(parseSI('1k'), 1e3); close(parseSI('4k7'), 4700); close(parseSI('100n'), 1e-7); close(parseSI('1meg'), 1e6);
    close(parseSI('1M'), 1e-3); close(parseSI('10uF'), 1e-5); close(parseSI('2.2µ'), 2.2e-6); close(parseSI('1e3'), 1e3);
    close(parseSI('5V'), 5); close(parseSI('-3.3'), -3.3); close(parseSI('.5'), 0.5);
  });
  it('rejects things that are not numbers', () => {
    for (const s of ['', 'abc', 'SIN(0 1 1k)', '1 2', '{R}']) expect(parseSI(s)).toBeNull();
  });
  it('normalises numbers for the netlist and passes expressions through', () => {
    expect(spiceValue('4k7')).toBe('4700'); expect(spiceValue('100n')).toBe('1e-7'); expect(spiceValue('SIN(0 1  1k)')).toBe('SIN(0 1 1k)');
  });
  it('formats with engineering prefixes', () => {
    expect(formatSI(0.0047, 'A')).toBe('4.7mA'); expect(formatSI(1590, 'Hz')).toBe('1.59kHz'); expect(formatSI(0, 'V')).toBe('0V'); expect(formatSI(-2.5e-6, 's')).toBe('-2.5µs');
  });
  it('picks round ticks', () => { expect(niceTicks(0, 0.01, 10)).toEqual([0, 0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01]); });
});

describe('symbol transforms', () => {
  it('rotates clockwise and mirrors before rotating', () => {
    const at = { x: 10, y: 10, mirror: false };
    expect(toWorld({ ...at, rot: 0 }, 0, -2)).toEqual({ x: 10, y: 8 });
    expect(toWorld({ ...at, rot: 90 }, 0, -2)).toEqual({ x: 12, y: 10 });
    expect(toWorld({ ...at, rot: 180 }, 0, -2)).toEqual({ x: 10, y: 12 });
    expect(toWorld({ ...at, rot: 270 }, 0, -2)).toEqual({ x: 8, y: 10 });
    expect(toWorld({ ...at, rot: 0, mirror: true }, 1, -2)).toEqual({ x: 9, y: 8 });
  });
});

const P = (kind: Part['kind'], ref: string, x: number, y: number, value = '1k', rot: Part['rot'] = 0): Part => ({ id: `${kind}${ref}${x}_${y}`, kind, ref, x, y, rot, mirror: false, value });
const sch = (parts: Part[], w: number[][], patch: Partial<Schematic> = {}): Schematic => ({ ...emptySchematic(), parts, wires: w.map(([x1, y1, x2, y2], i) => ({ id: `w${i}`, x1, y1, x2, y2 })), ...patch });

describe('netlister', () => {
  it('turns the RC example into the expected cards', () => {
    const c = compile(EXAMPLES[0].build());
    expect(c.issues).toEqual([]);
    expect(c.netlist.split('\n')).toEqual(['* RC low-pass', 'V1 in 0 SIN(0 1 1k)', 'R1 out in 1000', 'C1 out 0 1e-7', '.options savecurrents', '.tran 0.00001 0.005', '.end', '']);
  });
  it('compiles every example without issues', () => {
    for (const ex of EXAMPLES) expect(compile(ex.build()).issues, ex.name).toEqual([]);
  });
  it('connects a wire end that lands mid-wire, but not two wires that cross', () => {
    const base = [P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('R', 'R1', 10, 2), P('GND', '', 10, 4, '')];
    const tee = compile(sch(base, [[0, 0, 20, 0], [10, 0, 10, -5]]));
    expect(tee.pinNode.get('RR110_2:1')).toBe(tee.pinNode.get('VV10_2:+'));
    expect(tee.junctions).toEqual([{ x: 10, y: 0 }]);
    const cross = compile(sch([...base, P('R', 'R2', 5, 7), P('GND', '', 5, 9, '')], [[0, 0, 10, 0], [5, -3, 5, 5]]));
    expect(cross.pinNode.get('RR25_7:1')).not.toBe(cross.pinNode.get('VV10_2:+'));
    expect(cross.junctions).toEqual([]);
  });
  it('joins nets that carry the same label', () => {
    const c = compile(sch([P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('LABEL', '', 0, 0, 'VCC'), P('R', 'R1', 10, 2), P('LABEL', '', 10, 0, 'vcc'), P('GND', '', 10, 4, '')], []));
    expect(c.issues).toEqual([]);
    expect(c.netlist).toContain('R1 vcc 0 1000');
  });
  it('reports missing ground, dangling pins, duplicate references and bad values', () => {
    const messages = (s: Schematic) => compile(s).issues.map((i) => i.message).join(' | ');
    expect(messages(sch([P('R', 'R1', 0, 0)], []))).toMatch(/No ground/);
    expect(messages(sch([P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('R', 'R1', 0, -2)], []))).toMatch(/R1 pin 1 is not connected/);
    expect(messages(sch([P('R', 'R1', 0, 2), P('R', 'R1', 0, -2), P('GND', '', 0, 4, '')], []))).toMatch(/Two parts are called R1/);
    expect(messages(sch([P('R', 'R1', 0, 2, 'lots'), P('GND', '', 0, 4, '')], []))).toMatch(/not a number/);
    expect(messages(sch([], []))).toMatch(/Nothing to simulate/);
    expect(compile(sch([P('R', 'R1', 0, 0)], [])).ok).toBe(false);
  });
  it('emits a built-in model once, only when used, and keeps user directives', () => {
    const c = compile(sch([P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('D', 'D1', 0, -2, 'dgen'), P('D', 'D2', 0, -6, 'DGEN'), P('R', 'R1', 0, -10)], [[0, -12, 5, -12], [5, -12, 5, 4], [5, 4, 0, 4]], { directives: '.param x=1\n.end' }));
    expect(c.issues).toEqual([]);
    expect(c.netlist.match(/\.model DGEN/g)).toHaveLength(1);
    expect(c.netlist).toContain('.param x=1');
    expect(c.netlist.match(/\.end\b/g)).toHaveLength(1);
  });
  it('orders BJT nodes the way SPICE expects whatever the symbol pin order', () => {
    const q = P('PNP', 'Q1', 0, 0, 'PNP_GEN');
    const pins = Object.fromEntries(pinPositions(q).map((p) => [p.name, p]));
    const c = compile(sch([q, P('LABEL', '', pins.E.x, pins.E.y, 'e'), P('LABEL', '', pins.B.x, pins.B.y, 'b'), P('LABEL', '', pins.C.x, pins.C.y, 'c')], []));
    expect(c.netlist).toContain('Q1 c b e PNP_GEN');
  });
});

describe('topology rules', () => {
  const V = (ref: string, p: string, m: string): Device => ({ partId: ref, ref, kind: 'V', nodes: { '+': p, '-': m } });
  const I = (ref: string, p: string, m: string): Device => ({ partId: ref, ref, kind: 'I', nodes: { '+': p, '-': m } });
  const R = (ref: string, a: string, b: string): Device => ({ partId: ref, ref, kind: 'R', nodes: { '1': a, '2': b } });
  const C = (ref: string, a: string, b: string): Device => ({ partId: ref, ref, kind: 'C', nodes: { '1': a, '2': b } });
  const L = (ref: string, a: string, b: string): Device => ({ partId: ref, ref, kind: 'L', nodes: { '1': a, '2': b } });
  const msgs = (d: Device[], level?: string) => topologyFindings(d).filter((f) => !level || f.level === level).map((f) => f.message);

  it('accepts ordinary circuits', () => {
    expect(topologyFindings([V('V1', 'in', '0'), R('R1', 'in', 'out'), R('R2', 'out', '0'), C('C1', 'out', '0')])).toEqual([]);
    expect(topologyFindings([V('V1', 'a', '0'), V('V2', 'b', 'a'), R('R1', 'b', '0')])).toEqual([]); // series sources are fine
    expect(topologyFindings([I('I1', 'n', '0'), R('R1', 'n', '0')])).toEqual([]);
  });
  it('flags parallel voltage sources, a source across an inductor, and a shorted source', () => {
    expect(msgs([V('V1', 'a', '0'), V('V2', 'a', '0'), R('R1', 'a', '0')], 'error')[0]).toMatch(/V2 closes a loop/);
    expect(msgs([V('V1', 'a', '0'), L('L1', 'a', '0')], 'error')[0]).toMatch(/L1 closes a loop/);
    expect(msgs([V('V1', 'a', 'a'), R('R1', 'a', '0')], 'error')[0]).toMatch(/V1 is shorted/);
    // three-element loop, not just a pair
    expect(msgs([V('V1', 'a', '0'), V('V2', 'b', 'a'), L('L1', 'b', '0')], 'error')[0]).toMatch(/L1 closes a loop/);
  });
  it('flags current sources that feed a part with no other way back', () => {
    const series = msgs([I('I1', 'n', '0'), I('I2', '0', 'n'), R('R1', 'x', '0'), V('V1', 'x', '0')], 'error');
    expect(series).toHaveLength(1);
    expect(series[0]).toMatch(/I1, I2 push current/);
    const island = msgs([I('I1', '0', 'a'), R('R1', 'a', 'b'), R('R2', 'b', 'a')], 'error');
    expect(island[0]).toMatch(/I1 pushes current/);
  });
  it('warns, but does not error, when a net has no DC path to ground', () => {
    const f = topologyFindings([V('V1', 'in', '0'), C('C1', 'in', 'x'), R('R1', 'y', '0'), I('I1', 'y', 'x'), C('C2', 'x', 'y')]);
    expect(f.filter((x) => x.level === 'error')).toEqual([]);
    expect(f.map((x) => x.message).join(' ')).toMatch(/Net x has no DC path to ground \(only capacitors, current sources touch it\)/);
    const gate: Device = { partId: 'M1', ref: 'M1', kind: 'NMOS', nodes: { D: 'd', G: 'g', S: '0' } };
    const g = topologyFindings([V('V1', 'in', '0'), C('C1', 'in', 'g'), R('R1', 'd', 'in'), gate]);
    expect(g.map((x) => x.message).join(' ')).toMatch(/Net g has no DC path.*capacitors, MOSFET gates/);
  });
  it('is wired into compile, and stays quiet while pins are still dangling', () => {
    const two = sch([P('V', 'V1', 0, 0, '5'), P('V', 'V2', 4, 0, '3'), P('GND', '', 0, 2, ''), P('R', 'R1', 8, 0, '1k')], [[0, -2, 4, -2], [0, 2, 4, 2], [4, -2, 8, -2], [4, 2, 8, 2]]);
    const out = compile(two);
    expect(out.ok).toBe(false);
    expect(out.issues.map((i) => i.message).join(' | ')).toMatch(/V2 closes a loop/);
    const dangling = compile(sch([P('V', 'V1', 0, 0, '5'), P('V', 'V2', 4, 0, '3'), P('GND', '', 0, 2, '')], [[0, 2, 4, 2]]));
    expect(dangling.issues.map((i) => i.message).join(' | ')).not.toMatch(/closes a loop/);
  });
});

describe('subcircuits', () => {
  const ex = () => EXAMPLES.find((e) => /Two RC stages/.test(e.name))!.build();
  it('lays pins out from the port list: half down each side, on integer coordinates', () => {
    expect(subcktSymbol(['in', 'out']).pins).toEqual([{ name: 'in', x: -3, y: 0 }, { name: 'out', x: 3, y: 0 }]);
    const five = subcktSymbol(['a', 'b', 'c', 'd', 'e']);
    expect(five.pins.filter((p) => p.x < 0).map((p) => p.name)).toEqual(['a', 'b', 'c']);
    expect(five.pins.filter((p) => p.x > 0).map((p) => p.name)).toEqual(['d', 'e']);
    for (const p of five.pins) { expect(Number.isInteger(p.x)).toBe(true); expect(Number.isInteger(p.y)).toBe(true); }
    expect(new Set(five.pins.map((p) => `${p.x},${p.y}`)).size).toBe(5);
  });
  it('emits the definition once, however many instances, and keeps inner references local', () => {
    const c = compile(ex());
    expect(c.issues).toEqual([]);
    const lines = c.netlist.split('\n');
    expect(lines.filter((l) => l.startsWith('.subckt'))).toEqual(['.subckt RCSTAGE in out']);
    expect(lines).toContain('X1 in mid RCSTAGE');
    expect(lines).toContain('X2 mid out RCSTAGE');
    expect(lines.indexOf('.ends RCSTAGE')).toBeLessThan(lines.indexOf('V1 in 0 AC 1'));
    expect(lines.filter((l) => /^R1 /.test(l))).toHaveLength(2); // one inside, one on top: no clash
  });
  it('does not emit a definition nothing uses', () => {
    const s = ex();
    const unused = { ...s, parts: s.parts.filter((p) => p.kind !== 'SUBCKT'), wires: [], subckts: s.subckts };
    expect(compile(unused).netlist).not.toContain('.subckt');
  });
  it('reports a missing definition, a bad name, and a subcircuit placed inside itself', () => {
    const s = ex();
    const gone = compile({ ...s, subckts: [] });
    expect(gone.ok).toBe(false);
    expect(gone.issues.map((i) => i.message).join('|')).toMatch(/X1: there is no subcircuit called "RCSTAGE"/);
    const selfRef: Schematic = { ...s, subckts: [{ ...s.subckts[0], parts: [...s.subckts[0].parts, { ...P('SUBCKT', 'X1', 30, 0, 'RCSTAGE'), ports: ['in', 'out'] }] }] };
    expect(compile(selfRef).issues.map((i) => i.message).join('|')).toMatch(/RCSTAGE contains itself \(RCSTAGE → RCSTAGE\)/);
  });
  it('checks the inside of a subcircuit, and prefixes where the problem is', () => {
    const s = ex();
    const broken: Schematic = { ...s, subckts: [{ ...s.subckts[0], parts: s.subckts[0].parts.map((p) => (p.kind === 'R' ? { ...p, value: 'lots' } : p)) }] };
    const c = compile(broken);
    expect(c.ok).toBe(false);
    expect(c.issues.map((i) => i.message)).toContain('In subcircuit RCSTAGE: R1: "lots" is not a number');
  });
  it('compiles one sheet on its own for editing: no ground needed, ports are connected, ids resolve', () => {
    const s = ex();
    const c = compile(s, { sheet: 'RCSTAGE' });
    expect(c.issues).toEqual([]);
    expect(c.netlist).toBe('.subckt RCSTAGE in out\nR1 out in 1000\nC1 out 0 1e-7\n.ends RCSTAGE\n');
    const port = s.subckts[0].parts.find((p) => p.kind === 'PORT')!;
    expect(c.pinNode.get(`${port.id}:port`)).toBe('in');
    expect(compile(s, { sheet: 'nope' }).ok).toBe(false);
  });
  it('warns about an unconnected port and errors on duplicate or ground-named ports', () => {
    const s = ex();
    const def = s.subckts[0];
    const withPort = (name: string, x: number): Schematic => ({ ...s, subckts: [{ ...def, parts: [...def.parts, P('PORT', '', x, 10, name)] }] });
    expect(compile(withPort('spare', 30), { sheet: 'RCSTAGE' }).issues.map((i) => `${i.level}: ${i.message}`)).toContain('warning: Port "spare" is not connected to anything inside the subcircuit');
    expect(compile(withPort('in', 30), { sheet: 'RCSTAGE' }).issues.some((i) => i.level === 'error' && /Two ports are called "in"/.test(i.message))).toBe(true);
    expect(compile(withPort('gnd', 30), { sheet: 'RCSTAGE' }).issues.some((i) => i.level === 'error' && /cannot be called ground/.test(i.message))).toBe(true);
  });
  it('keeps instances in step with their definition when ports change', () => {
    const s = ex();
    const def = s.subckts[0];
    const more: Schematic = { ...s, subckts: [{ ...def, parts: [...def.parts, P('PORT', '', 30, 10, 'gnd2')] }] };
    expect(syncInstances(s)).toBe(s); // already in step: same object
    const synced = normalizeAll(more);
    expect(synced.parts.filter((p) => p.kind === 'SUBCKT').every((p) => p.ports!.join() === 'in,out,gnd2')).toBe(true);
    expect(pinsOf(synced.parts.find((p) => p.ref === 'X1')!)).toHaveLength(3);
    expect(subcktPorts(more.subckts[0])).toEqual(['in', 'out', 'gnd2']);
  });
  it('round-trips through save and load, including instance ports and definitions', () => {
    const s = ex();
    const back = parseSchematic(JSON.stringify(s));
    expect(back.subckts).toHaveLength(1);
    expect(back.subckts[0].parts.filter((p) => p.kind === 'PORT').map((p) => p.value)).toEqual(['in', 'out']);
    expect(compile(back).netlist).toBe(compile(s).netlist);
    expect(parseSchematic(JSON.stringify({ ...emptySchematic(), subckts: undefined })).subckts).toEqual([]); // files from before subcircuits
    expect(() => parseSchematic(JSON.stringify({ ...s, subckts: [{ name: '1bad', parts: [], wires: [] }] }))).toThrow(/Bad subcircuit name/);
  });
  it('edits a subcircuit sheet in place without touching the top sheet', () => {
    const s = ex();
    const view = sheetOf(s, 'RCSTAGE');
    expect(view.parts).toBe(s.subckts[0].parts);
    const edited = withSheet(s, 'RCSTAGE', { ...view, parts: view.parts.filter((p) => p.kind !== 'C') });
    expect(edited.parts).toBe(s.parts);
    expect(edited.subckts[0].parts.some((p) => p.kind === 'C')).toBe(false);
    expect(sheetOf(s, null)).toBe(s);
  });
  it('creates, validates and removes definitions; places instances with their ports', () => {
    let s = emptySchematic();
    expect(subcktNameProblem(s, '')).toMatch(/name/);
    expect(subcktNameProblem(s, '1x')).toMatch(/letters/);
    s = addSubckt(s, 'Amp');
    expect(subcktNameProblem(s, 'amp')).toMatch(/already/);
    const placed = addPart(s, 'SUBCKT', 4, 4, 0, false, { value: 'Amp', ports: ['a', 'b', 'c'] });
    expect(placed.sch.parts[0]).toMatchObject({ kind: 'SUBCKT', ref: 'X1', value: 'Amp', ports: ['a', 'b', 'c'] });
    expect(removeSubckt(placed.sch, 'Amp').subckts).toEqual([]);
    let sheet = emptySchematic();
    const names: string[] = [];
    for (let i = 0; i < 4; i++) { const r = addPart(sheet, 'PORT', i * 6, 0, 0, false); sheet = r.sch; names.push(r.sch.parts[i].value); }
    expect(names).toEqual(['in', 'out', 'p3', 'p4']);
  });
});

describe('normalizeWires', () => {
  it('splits a wire where a pin lands mid-span', () => {
    const base = sch([P('R', 'R1', 10, 2)], [[0, 0, 20, 0]]);
    const out = normalizeWires(base);
    expect(out.wires).toHaveLength(2);
    expect(out.wires.map((w) => [w.x1, w.y1, w.x2, w.y2]).sort((a, b) => a[0] - b[0])).toEqual([[0, 0, 10, 0], [10, 0, 20, 0]]);
  });
  it('merges two collinear wires that share an unburdened endpoint', () => {
    const out = normalizeWires(sch([], [[0, 0, 10, 0], [10, 0, 20, 0]]));
    expect(out.wires).toHaveLength(1);
    expect(out.wires[0]).toMatchObject({ x1: 0, y1: 0, x2: 20, y2: 0 });
  });
  it('does not merge through a point where a part pin sits', () => {
    const base = sch([P('GND', '', 10, 0, '')], [[0, 0, 10, 0], [10, 0, 20, 0]]);
    const out = normalizeWires(base);
    expect(out.wires).toHaveLength(2);
  });
  it('leaves an already-normalized schematic untouched (same reference)', () => {
    const base = sch([], [[0, 0, 10, 0]]);
    expect(normalizeWires(base)).toBe(base);
  });
});

describe('moveItems rubber-banding', () => {
  it('stretches a static wire attached to a moving pin, staying straight when possible', () => {
    const r1 = P('R', 'R1', 0, 2);
    const base = sch([r1], [[0, 0, -10, 0]]); // pin1 of R1 is at (0,0)
    const out = moveItems(base, new Set([r1.id]), 5, 0);
    expect(out.parts[0]).toMatchObject({ x: 5, y: 2 });
    expect(out.wires).toHaveLength(1);
    expect(out.wires[0]).toMatchObject({ x1: -10, y1: 0, x2: 5, y2: 0 });
  });
  it('adds a bend when the stretch is not axis-aligned', () => {
    const r1 = P('R', 'R1', 0, 2);
    const base = sch([r1], [[0, 0, 0, -10]]);
    const out = moveItems(base, new Set([r1.id]), 5, 0);
    expect(out.wires).toHaveLength(2);
    const pts = out.wires.map((w) => [[w.x1, w.y1], [w.x2, w.y2]]);
    expect(pts).toContainEqual([[0, -10], [5, -10]]);
    expect(pts).toContainEqual([[5, -10], [5, 0]]);
  });
  it('translates a wire wholesale when both ends are moving together', () => {
    const r1 = P('R', 'R1', 0, 2);
    const r2 = P('R', 'R2', 0, 10);
    const base = sch([r1, r2], [[0, 4, 0, 8]]); // wire connects R1's pin2 to R2's pin1
    const out = moveItems(base, new Set([r1.id, r2.id]), 3, 0);
    expect(out.wires).toHaveLength(1);
    expect(out.wires[0]).toMatchObject({ x1: 3, y1: 4, x2: 3, y2: 8 });
  });
});

describe('dragging a wire', () => {
  it('moves a wire sideways and keeps its neighbours attached and orthogonal', () => {
    const base = sch([], [[0, 0, 10, 0], [10, 0, 10, 8], [10, 8, 20, 8]]);
    const mid = base.wires[1];
    const out = moveItems(base, new Set([mid.id]), 4, 0);
    // Direction is irrelevant to connectivity, so compare each wire with its ends sorted.
    const segs = out.wires.map((w) => (w.x1 + w.y1 <= w.x2 + w.y2 ? [w.x1, w.y1, w.x2, w.y2] : [w.x2, w.y2, w.x1, w.y1]));
    expect(segs).toContainEqual([14, 0, 14, 8]);
    expect(segs).toContainEqual([0, 0, 14, 0]);
    expect(segs).toContainEqual([14, 8, 20, 8]);
    for (const w of out.wires) expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true);
  });
});

describe('copy, paste, duplicate', () => {
  const base = sch([P('R', 'R1', 0, 2), P('R', 'R2', 10, 2), P('GND', '', 20, 0, '')], [[0, 4, 10, 4]]);
  it('gives pasted parts fresh ids and the next free designator, and shifts everything', () => {
    const clip = copyItems(base, new Set([base.parts[0].id, base.wires[0].id]));
    const out = pasteItems(base, clip, 2, 2);
    expect(out.sch.parts).toHaveLength(4);
    const added = out.sch.parts[3];
    expect(added).toMatchObject({ kind: 'R', ref: 'R3', x: 2, y: 4, value: '1k' });
    expect(new Set(out.sch.parts.map((p) => p.id)).size).toBe(4);
    expect(out.sch.wires[1]).toMatchObject({ x1: 2, y1: 6, x2: 12, y2: 6 });
    expect(out.ids).toHaveLength(2);
    expect(out.ids).toContain(added.id);
  });
  it('does not give a ground symbol a designator', () => {
    const out = pasteItems(base, copyItems(base, new Set([base.parts[2].id])), 1, 1);
    expect(out.sch.parts[3]).toMatchObject({ kind: 'GND', ref: '' });
  });
  it('pasting twice stays unique and leaves the source untouched', () => {
    const clip = copyItems(base, new Set([base.parts[0].id]));
    const once = pasteItems(base, clip, 2, 2).sch;
    const twice = pasteItems(once, clip, 4, 4).sch;
    expect(twice.parts.map((p) => p.ref)).toEqual(['R1', 'R2', '', 'R3', 'R4']);
    expect(base.parts).toHaveLength(3);
  });
});

describe('removeWireSpan', () => {
  it('deletes only the stretch between connection points, keeping the rest of the run', () => {
    // A long wire with another wire's end landing at x=10 and a pin at x=20.
    const base = sch([P('GND', '', 20, 0, '')], [[0, 0, 30, 0], [10, 0, 10, 6]]);
    const run = base.wires[0];
    const out = removeWireSpan(base, new Set([run.id]), { x: 15, y: 0 });
    const segs = out.wires.map((w) => [w.x1, w.y1, w.x2, w.y2]);
    expect(segs).toContainEqual([0, 0, 10, 0]);
    expect(segs).toContainEqual([20, 0, 30, 0]);
    expect(segs).toContainEqual([10, 0, 10, 6]);
    expect(segs).toHaveLength(3);
  });
  it('removes a whole wire when nothing else touches it', () => {
    const base = sch([], [[0, 0, 10, 0]]);
    expect(removeWireSpan(base, new Set([base.wires[0].id]), { x: 5, y: 0 }).wires).toHaveLength(0);
  });
  it('does nothing when the point is not on a selected wire', () => {
    const base = sch([], [[0, 0, 10, 0]]);
    expect(removeWireSpan(base, new Set([base.wires[0].id]), { x: 5, y: 3 })).toBe(base);
    expect(removeWireSpan(base, new Set(), { x: 5, y: 0 })).toBe(base);
  });
});

describe('label positions', () => {
  it('offsets accumulate, survive save and load, and do not touch the netlist', () => {
    const base = sch([P('R', 'R1', 0, 2)], []);
    const a = withLabelOffset(base, base.parts[0].id, 'ref', { x: 1, y: -2 });
    const b = withLabelOffset(a, base.parts[0].id, 'ref', { x: 2, y: 0 });
    expect(b.parts[0].refOffset).toEqual({ x: 3, y: -2 });
    expect(b.parts[0].valueOffset).toBeUndefined();
    const back = parseSchematic(JSON.stringify(b));
    expect(back.parts[0].refOffset).toEqual({ x: 3, y: -2 });
    expect(compile(b).netlist).toBe(compile(base).netlist);
  });
});

describe('vector labels', () => {
  it('reads like LTspice', () => {
    expect(vectorLabel('v(out)')).toBe('V(out)'); expect(vectorLabel('i(v1)')).toBe('I(V1)');
    expect(vectorLabel('i(@r1[i])')).toBe('I(R1)'); expect(vectorLabel('i(@d1[id])')).toBe('I(D1)'); expect(vectorLabel('i(@q1[ic])')).toBe('I(Q1:c)');
  });
});
