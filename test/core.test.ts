import { describe, expect, it } from 'vitest';
import { formatSI, niceTicks, parseSI, spiceValue } from '../src/core/units';
import { compile } from '../src/core/netlist';
import { EXAMPLES } from '../src/core/examples';
import { emptySchematic, type Part, type Schematic } from '../src/core/types';
import { pinPositions, toWorld } from '../src/core/symbols';
import { topologyFindings, type Device } from '../src/core/rules';
import { vectorLabel } from '../src/sim/result';
import { addPart, addSubckt, copyItems, moveItems, normalizeAll, normalizeWires, parseSchematic, pasteItems, removeSubckt, removeWireSpan, sheetOf, subcktNameProblem, withSheet } from '../src/ui/store';
import { renameSubckt, subcktPorts, syncInstances } from '../src/core/subckt';
import { makeSubckt } from '../src/core/extract';
import { dotParamNames, exprNames, parseParams } from '../src/core/params';
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

describe('subcircuit follow-ups', () => {
  const rcs = () => EXAMPLES.find((e) => /Two RC stages/.test(e.name))!.build();
  const divs = () => EXAMPLES.find((e) => /with parameters/.test(e.name))!.build();
  const text = (c: ReturnType<typeof compile>) => c.issues.map((i) => i.message).join(' | ');

  it('renames a definition and every instance of it, on every sheet', () => {
    const s = rcs();
    // a second subcircuit that itself uses RCSTAGE
    const outer: Schematic = { ...s, subckts: [...s.subckts, { name: 'TWOSTAGE', parts: [{ ...P('SUBCKT', 'X1', 0, 0, 'RCSTAGE'), ports: ['in', 'out'] }], wires: [] }] };
    const r = renameSubckt(outer, 'RCSTAGE', 'Lowpass');
    expect(r.subckts.map((d) => d.name)).toEqual(['Lowpass', 'TWOSTAGE']);
    expect(r.parts.filter((p) => p.kind === 'SUBCKT').map((p) => p.value)).toEqual(['Lowpass', 'Lowpass']);
    expect(r.subckts[1].parts[0].value).toBe('Lowpass');
    expect(compile(r).netlist).toContain('.subckt Lowpass in out');
    expect(compile(r).netlist).toContain('X1 in mid Lowpass');
    expect(compile(renameSubckt(rcs(), 'rcstage', 'Q')).issues).toEqual([]); // case-insensitive match
  });

  it('parses parameters, rewrites numbers the way ngspice reads them, and refuses what it cannot', () => {
    expect(parseParams('R=4k7  C = 100n').items).toEqual([{ name: 'R', value: '4700' }, { name: 'C', value: '1e-7' }]);
    expect(parseParams('G={2*R}').items).toEqual([{ name: 'G', value: '{2*R}' }]);
    expect(parseParams('').items).toEqual([]);
    expect(parseParams('R').error).toMatch(/NAME=value/);
    expect(parseParams('R=abc').error).toMatch(/not a number/);
    expect(parseParams('R=1k r=2k').error).toMatch(/twice/);
    expect(parseParams('1R=2').error).toMatch(/NAME=value/);
    expect(parseParams('R={a b}').error).toMatch(/not a number/); // no spaces in an expression
  });
  it('never lets a 4k7-style value reach ngspice (it hangs the engine)', () => {
    const s = divs();
    const edited: Schematic = { ...s, subckts: [{ ...s.subckts[0], params: 'R=4k7' }] };
    const nl = compile(edited).netlist;
    expect(nl).toContain('.subckt DIV in out params: R=4700');
    expect(nl).not.toMatch(/4k7/i);
    const inst = { ...edited, parts: edited.parts.map((p) => (p.ref === 'X2' ? { ...p, params: 'R=2k2' } : p)) };
    expect(compile(inst).netlist).toContain('X2 in quarter DIV R=2200');
  });
  it('emits defaults on the definition and overrides on the instance', () => {
    const c = compile(divs());
    expect(c.issues).toEqual([]);
    const lines = c.netlist.split('\n');
    expect(lines).toContain('.subckt DIV in out params: R=1000');
    expect(lines).toContain('X1 in half DIV');
    expect(lines).toContain('X2 in quarter DIV R=3000');
  });
  it('catches an unknown parameter name (ngspice would ignore it) and a malformed list', () => {
    const s = divs();
    const typo: Schematic = { ...s, parts: s.parts.map((p) => (p.ref === 'X2' ? { ...p, params: 'Q=3k' } : p)) };
    expect(text(compile(typo))).toMatch(/X2: DIV has no parameter "Q" \(it has R\)/);
    expect(compile(typo).ok).toBe(false);
    const none: Schematic = { ...rcs(), parts: rcs().parts.map((p) => (p.ref === 'X1' ? { ...p, params: 'R=1k' } : p)) };
    expect(text(compile(none))).toMatch(/RCSTAGE has no parameter "R" \(it has none\)/);
    const bad: Schematic = { ...s, subckts: [{ ...s.subckts[0], params: 'R=' }] };
    expect(text(compile(bad))).toMatch(/In subcircuit DIV: Parameters: "R=" is not written NAME=value/);
    expect(text(compile(bad, { sheet: 'DIV' }))).toMatch(/Parameters: /);
  });
  it('reads the names an expression uses, ignoring numbers, functions and pi', () => {
    expect(exprNames('{R}')).toEqual(['r']);
    expect(exprNames('{2*R + Cload}')).toEqual(['r', 'cload']);
    expect(exprNames('{sqrt(Q)*1e3 + pi}')).toEqual(['q']);
    expect(exprNames('{1e-3*x}')).toEqual(['x']);
    expect(exprNames('4700')).toEqual([]);
    expect(dotParamNames('.model D1 D\n.param A=1k  B = {2*A}\n.PARAM c=3')).toEqual(['a', 'b', 'c']);
  });
  it('refuses an undefined {name} (ngspice hangs on it), but accepts .param and subcircuit parameters', () => {
    const top = (value: string, directives = ''): Schematic => ({ ...sch([P('V', 'V1', 0, 2, '5'), P('R', 'R1', 4, 2, value), P('GND', '', 0, 4, ''), P('GND', '', 4, 4, '')], [[0, 0, 4, 0]]), directives });
    expect(compile(top('{Q}')).issues.map((i) => i.message).join('|')).toMatch(/R1: \{Q\} uses q, which is not defined/);
    expect(compile(top('{Q}')).ok).toBe(false);
    expect(compile(top('{Q}', '.param Q=2k')).issues).toEqual([]);
    expect(compile(top('{2*Q}', '.param Q=2k')).ok).toBe(true);
    // inside a subcircuit, its own parameters count; another definition's do not
    const d = divs();
    expect(compile(d).issues).toEqual([]);
    const noParam: Schematic = { ...d, subckts: [{ ...d.subckts[0], params: undefined }] };
    expect(text(compile(noParam))).toMatch(/In subcircuit DIV: R1: \{R\} uses r/);
    expect(text(compile(noParam, { sheet: 'DIV' }))).toMatch(/R1: \{R\} uses r/);
    // an instance override may use a global .param
    const useGlobal: Schematic = { ...d, directives: '.param K=2k', parts: d.parts.map((p) => (p.ref === 'X2' ? { ...p, params: 'R={K}' } : p)) };
    expect(compile(useGlobal).issues).toEqual([]);
    const undefinedGlobal: Schematic = { ...d, parts: d.parts.map((p) => (p.ref === 'X2' ? { ...p, params: 'R={K}' } : p)) };
    expect(text(compile(undefinedGlobal))).toMatch(/X2: parameters use k, which is not defined here/);
  });
  it('a subcircuit run on its own defines its parameter defaults at the top level', () => {
    const d = divs();
    const def = d.subckts[0];
    const bench = [P('V', 'V1', 3, 2, '10'), P('GND', '', 3, 4, '')].map((p) => ({ ...p, bench: true }));
    const wired: Schematic = { ...d, subckts: [{ ...def, parts: [...def.parts, ...bench], wires: [...def.wires, { id: 'bw', x1: 3, y1: 0, x2: 6, y2: 0 }] }] };
    const c = compile(wired, { sheet: 'DIV', standalone: true });
    expect(c.issues).toEqual([]);
    expect(c.netlist.split('\n').slice(0, 3)).toEqual(['* DIV on its own', '.param R=1000', 'R1 out in {R}']);
  });
  it('keeps params and the test-bench flag through save and load', () => {
    const s = divs();
    const flagged: Schematic = { ...s, subckts: [{ ...s.subckts[0], parts: s.subckts[0].parts.map((p, i) => (i === 0 ? { ...p, bench: true } : p)) }] };
    const back = parseSchematic(JSON.stringify(flagged));
    expect(back.subckts[0].params).toBe('R=1k');
    expect(back.parts.find((p) => p.ref === 'X2')!.params).toBe('R=3k');
    expect(back.subckts[0].parts[0].bench).toBe(true);
    expect(back.subckts[0].parts[1].bench).toBeUndefined();
  });

  it('moves wires with the pins that survive when ports are added, removed or renamed', () => {
    const s = rcs();
    const x1 = s.parts.find((p) => p.ref === 'X1')!; // pins in (7,0) and out (13,0)
    const withPort = (ports: string[]): Schematic => ({ ...s, subckts: [{ ...s.subckts[0], parts: ports.map((name, i) => P('PORT', '', 6 + i * 3, 20, name)) }] });
    const endpoints = (sc: Schematic) => sc.wires.flatMap((w) => [`${w.x1},${w.y1}`, `${w.x2},${w.y2}`]);
    const pinOf = (sc: Schematic, name: string) => pinsOf(sc.parts.find((p) => p.ref === 'X1')!).find((q) => q.name === name)!;

    // a third port in front shifts the layout: in/out keep their wires
    const grown = normalizeAll(withPort(['gnd2', 'in', 'out']));
    const inPin = pinOf(grown, 'in'), outPin = pinOf(grown, 'out');
    expect(`${inPin.x},${inPin.y}`).not.toBe('7,0'); // it really moved
    expect(endpoints(grown)).toContain(`${inPin.x},${inPin.y}`);
    expect(endpoints(grown)).toContain(`${outPin.x},${outPin.y}`);
    // every wire is still straight, and V1 is still on the same net as the instance's in pin
    for (const w of grown.wires) expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true);
    const cg = compile(grown), v1 = grown.parts.find((p) => p.ref === 'V1')!, x1g = grown.parts.find((p) => p.ref === 'X1')!;
    expect(cg.pinNode.get(`${x1g.id}:in`)).toBe(cg.pinNode.get(`${v1.id}:+`));

    // a rename (same count) keeps the wire on that pin
    const renamed = normalizeAll(withPort(['input', 'out']));
    expect(endpoints(renamed)).toContain('7,0');
    expect(pinOf(renamed, 'input')).toMatchObject({ x: 7, y: 0 });
    // removing a port drops its wire attachment but leaves the other
    const shrunk = normalizeAll(withPort(['in']));
    expect(endpoints(shrunk)).toContain('7,0');
    expect(x1.ports).toEqual(['in', 'out']);
  });

  it('leaves a test bench out of the definition, but shows it on the sheet and runs it standalone', () => {
    const s = rcs();
    const def = s.subckts[0];
    const bench = [P('V', 'V1', 3, 2, 'AC 1'), P('GND', '', 3, 4, '')].map((p) => ({ ...p, bench: true }));
    const wired: Schematic = { ...s, subckts: [{ ...def, parts: [...def.parts, ...bench], wires: [...def.wires, { id: 'bw', x1: 3, y1: 0, x2: 6, y2: 0 }] }] };
    // emitted definition: unchanged, no source in it
    expect(compile(wired).netlist).toBe(compile(s).netlist);
    expect(compile(wired, { sheet: 'RCSTAGE' }).netlist).toBe('.subckt RCSTAGE in out\nR1 out in 1000\nC1 out 0 1e-7\n.ends RCSTAGE\n');
    // the sheet view checks the bench too, and has no ground complaint
    expect(compile(wired, { sheet: 'RCSTAGE' }).issues).toEqual([]);
    // standalone: a runnable circuit with the source in it and the ports as plain nets
    const alone = compile(wired, { sheet: 'RCSTAGE', standalone: true });
    expect(alone.issues).toEqual([]);
    const lines = alone.netlist.split('\n');
    expect(lines[0]).toBe('* RCSTAGE on its own');
    expect(lines).toContain('V1 in 0 AC 1');
    expect(lines).toContain('R1 out in 1000');
    expect(lines.some((l) => l.startsWith('.subckt'))).toBe(false);
    expect(lines.some((l) => l.startsWith('X'))).toBe(false);
    // without a bench its ports lead nowhere: standalone, that is a dangling pin
    expect(compile(s, { sheet: 'RCSTAGE', standalone: true }).issues.map((i) => i.message).join('|')).toMatch(/R1 pin 2 is not connected/);
    expect(compile(s, { sheet: 'nope', standalone: true }).ok).toBe(false);
  });
});

describe('make subcircuit from selection', () => {
  // The RC low-pass with a 1k load on its output, outside the part we extract (R1 + C1).
  const flat = (): Schematic => {
    const base = EXAMPLES.find((e) => /AC sweep/.test(e.name) && /RC low-pass/.test(e.name))!.build();
    const extra = [{ ...P('R', 'R2', 28, 12, '1k') }];
    const w = [[22, 8, 28, 8], [28, 8, 28, 10], [28, 14, 28, 16], [22, 16, 28, 16]].map(([x1, y1, x2, y2], i) => ({ id: `ld${i}`, x1, y1, x2, y2 }));
    return { ...base, parts: [...base.parts, ...extra], wires: [...base.wires, ...w] };
  };
  const wid = (s: Schematic, ...c: number[][]) => s.wires.filter((w) => c.some(([a, b, x, y]) => w.x1 === a && w.y1 === b && w.x2 === x && w.y2 === y)).map((w) => w.id);
  const sel = (s: Schematic) => new Set([...s.parts.filter((p) => p.ref === 'R1' || p.ref === 'C1').map((p) => p.id), ...wid(s, [10, 8, 14, 8], [18, 8, 22, 8], [22, 8, 22, 10], [22, 14, 22, 16], [10, 16, 22, 16])]);

  it('turns crossing nets into ports in left-to-right order, keeps ground global, and moves the selection', () => {
    const s = flat();
    const r = makeSubckt(s, null, sel(s), 'LOWPASS');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const def = r.sch.subckts[0];
    expect(def.name).toBe('LOWPASS');
    expect(subcktPorts(def)).toEqual(['in', 'out']);
    expect(def.parts.filter((p) => p.kind === 'R' || p.kind === 'C').map((p) => p.ref).sort()).toEqual(['C1', 'R1']);
    expect(def.parts.some((p) => p.kind === 'GND')).toBe(true); // ground stays a ground, not a port
    expect(r.sch.parts.some((p) => p.ref === 'R1' || p.ref === 'C1')).toBe(false);
    const inst = r.sch.parts.find((p) => p.id === r.instanceId)!;
    expect(inst).toMatchObject({ kind: 'SUBCKT', ref: 'X1', value: 'LOWPASS', ports: ['in', 'out'] });
    expect(r.sch.parts.some((p) => p.kind === 'GND')).toBe(true); // the outside kept a ground
    expect(compile(r.sch).issues).toEqual([]);
  });
  it('names auto-named ports p1, p2 and never reuses a name that is taken', () => {
    // V1 -> R1 -> R2 -> GND, no labels at all: select R1 and R2.
    const parts = [P('V', 'V1', 0, 2, '5'), P('R', 'R1', 6, 0, '1k', 90), P('R', 'R2', 12, 2, '1k'), P('GND', '', 0, 4, ''), P('GND', '', 12, 6, '')];
    const s = sch(parts, [[0, 0, 4, 0], [8, 0, 12, 0], [12, 0, 12, 2], [0, 4, 0, 4]]);
    const r = makeSubckt(s, null, new Set([parts[1].id, parts[2].id, ...s.wires.filter((w) => w.x1 === 8 || w.y1 === 0 && w.x2 === 12).map((w) => w.id)]), 'PAIR');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) expect(r.ports).toEqual(['p1']);
  });
  it('joins a net that crosses only by label with a label at the instance pin', () => {
    // Two islands that meet only through the label "link": R1 (selected) and R2 (not).
    const parts = [P('V', 'V1', 0, 2, '5'), P('R', 'R1', 6, 0, '1k', 90), P('R', 'R2', 20, 2, '1k'), P('GND', '', 0, 4, ''), P('GND', '', 20, 4, ''), P('LABEL', '', 12, 0, 'link'), P('LABEL', '', 20, 0, 'link')];
    const s = sch(parts, [[0, 0, 4, 0], [8, 0, 12, 0]]);
    const r = makeSubckt(s, null, new Set([parts[1].id, parts[5].id, ...s.wires.filter((w) => w.x1 === 8).map((w) => w.id)]), 'HALF');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.ports).toContain('link');
    expect(r.sch.parts.some((p) => p.kind === 'LABEL' && p.value === 'link' && p.x !== 12)).toBe(true);
    expect(compile(r.sch).issues).toEqual([]);
  });
  it('refuses an empty or wire-only selection, a selection with ports, and one that touches nothing', () => {
    const s = flat();
    expect(makeSubckt(s, null, new Set(), 'A')).toMatchObject({ ok: false, error: expect.stringMatching(/Select the parts/) });
    expect(makeSubckt(s, null, new Set(wid(s, [10, 8, 14, 8])), 'A')).toMatchObject({ ok: false, error: expect.stringMatching(/real part/) });
    const ex = EXAMPLES.find((e) => /Two RC stages/.test(e.name))!.build();
    const ports = new Set(ex.subckts[0].parts.map((p) => p.id));
    expect(makeSubckt(ex, 'RCSTAGE', ports, 'A')).toMatchObject({ ok: false, error: expect.stringMatching(/ports belong/) });
    const whole = new Set([...s.parts.map((p) => p.id), ...s.wires.map((w) => w.id)]);
    expect(makeSubckt(s, null, whole, 'A')).toMatchObject({ ok: false, error: expect.stringMatching(/not connected to the rest/) });
  });
  it('works inside a subcircuit sheet too, and leaves the top sheet alone', () => {
    const ex = EXAMPLES.find((e) => /Two RC stages/.test(e.name))!.build();
    const inner = ex.subckts[0];
    const c1 = inner.parts.find((p) => p.ref === 'C1')!, gnd = inner.parts.find((p) => p.kind === 'GND')!;
    const r = makeSubckt(ex, 'RCSTAGE', new Set([c1.id, gnd.id, ...inner.wires.filter((w) => w.x1 === 16 && w.y1 === 0).map((w) => w.id)]), 'CAP');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.sch.parts).toBe(ex.parts);
    expect(r.sch.subckts.map((d) => d.name)).toEqual(['RCSTAGE', 'CAP']);
    expect(r.sch.subckts[0].parts.some((p) => p.kind === 'SUBCKT' && p.value === 'CAP')).toBe(true);
    expect(compile(r.sch).issues).toEqual([]);
  });
});

describe('sweep in the netlist', () => {
  const rcSweep = (sweep: Schematic['sweep'], directives = ''): Schematic => {
    const s = EXAMPLES.find((e) => /RC low-pass — transient/.test(e.name))!.build();
    return { ...s, parts: s.parts.map((p) => (p.ref === 'R1' ? { ...p, value: '{R}' } : p)), directives, sweep };
  };
  it('defines the sweep parameter, so {R} is not "undefined", and emits it after the directives', () => {
    const c = compile(rcSweep({ param: 'R', values: '1k 2k' }, '.param Z=1'));
    expect(c.issues).toEqual([]);
    const lines = c.netlist.split('\n');
    expect(lines.indexOf('.param R=1000')).toBeGreaterThan(lines.indexOf('.param Z=1'));
    expect(lines).toContain('R1 out in {R}');
    expect(compile(rcSweep({ param: 'R', values: '1k 2k' }), { sweepValue: '2200' }).netlist).toContain('.param R=2200');
  });
  it('without a sweep, the same {R} is an undefined-name error', () => {
    expect(compile(rcSweep(undefined)).issues.map((i) => i.message).join('|')).toMatch(/R1: \{R\} uses r, which is not defined/);
  });
  it('reports a malformed sweep, and a clash with .param in the directives', () => {
    expect(compile(rcSweep({ param: 'R', values: '1k abc' })).issues.map((i) => i.message).join('|')).toMatch(/Sweep: "abc" is not a number/);
    const clash = compile(rcSweep({ param: 'R', values: '1k 2k' }, '.param R=5k'));
    expect(clash.ok).toBe(true);
    expect(clash.issues.map((i) => `${i.level}: ${i.message}`)).toContain('warning: R is set both in the SPICE directives and by the sweep: the sweep value is used');
  });
  it('survives save and load', () => {
    const s = rcSweep({ param: 'R', values: 'lin 1k 4k 4' });
    expect(parseSchematic(JSON.stringify(s)).sweep).toEqual({ param: 'R', values: 'lin 1k 4k 4' });
    expect(parseSchematic(JSON.stringify(rcSweep(undefined))).sweep).toBeUndefined();
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
