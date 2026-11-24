// Symbol library: geometry (grid units, unrotated), pins, and the SPICE card each
// part turns into. Adding a part means adding one entry here; the editor, the
// netlister and the palette all read from this table.

import type { Part, PartKind, Point } from './types';
import { spiceValue } from './units';

export interface Pin { name: string; x: number; y: number }

export interface SymbolDef {
  kind: PartKind;
  label: string;
  group: 'Passive' | 'Sources' | 'Semiconductors' | 'Connectivity' | 'Subcircuits';
  /** Reference prefix (R, C, Q). Empty = no designator. */
  prefix: string;
  pins: Pin[];
  /** Stroked outline as SVG path data. */
  path: string;
  /** Closed shape filled with the body colour (IC-style bodies). */
  body?: string;
  /** Solid-filled detail (arrow heads). */
  solid?: string;
  /** Extent used for selection and label placement: x0, y0, x1, y1. */
  box: [number, number, number, number];
  defaultValue: string;
  /** What the value field means, shown in the inspector. */
  valueLabel: string;
  valueHint?: string;
  /** SPICE line for this part. `n` holds node names in pin order. Null = no card. */
  card: ((part: Part, n: string[]) => string) | null;
}

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const TWO_PIN: Pin[] = [{ name: '1', x: 0, y: -2 }, { name: '2', x: 0, y: 2 }];
const model = (p: Part) => p.value.trim().replace(/\s+/g, '_') || 'MISSING_MODEL';

export const SYMBOLS: Record<PartKind, SymbolDef> = {
  R: {
    kind: 'R', label: 'Resistor', group: 'Passive', prefix: 'R', pins: TWO_PIN,
    path: 'M0 -2V-1M0 1V2M-0.4 -1H0.4V1H-0.4Z', box: [-0.6, -2, 0.6, 2],
    defaultValue: '1k', valueLabel: 'Resistance', valueHint: 'e.g. 4k7, 10k, 1meg',
    card: (p, n) => `R${p.ref.slice(1)} ${n[0]} ${n[1]} ${spiceValue(p.value)}`,
  },
  C: {
    kind: 'C', label: 'Capacitor', group: 'Passive', prefix: 'C', pins: TWO_PIN,
    path: 'M0 -2V-0.3M0 0.3V2M-0.8 -0.3H0.8M-0.8 0.3H0.8', box: [-0.8, -2, 0.8, 2],
    defaultValue: '100n', valueLabel: 'Capacitance', valueHint: 'e.g. 100n, 4u7, 22p',
    card: (p, n) => `C${p.ref.slice(1)} ${n[0]} ${n[1]} ${spiceValue(p.value)}`,
  },
  L: {
    kind: 'L', label: 'Inductor', group: 'Passive', prefix: 'L', pins: TWO_PIN,
    path: 'M0 -2V-1.2a0.3 0.3 0 0 1 0 0.6a0.3 0.3 0 0 1 0 0.6a0.3 0.3 0 0 1 0 0.6a0.3 0.3 0 0 1 0 0.6V2',
    box: [-0.5, -2, 0.6, 2],
    defaultValue: '10m', valueLabel: 'Inductance', valueHint: 'e.g. 10m, 100u',
    card: (p, n) => `L${p.ref.slice(1)} ${n[0]} ${n[1]} ${spiceValue(p.value)}`,
  },
  V: {
    kind: 'V', label: 'Voltage source', group: 'Sources', prefix: 'V',
    pins: [{ name: '+', x: 0, y: -2 }, { name: '-', x: 0, y: 2 }],
    path: `M0 -2V-1M0 1V2M-0.3 -0.5H0.3M0 -0.8V-0.2M-0.3 0.5H0.3${circle(0, 0, 1)}`, box: [-1, -2, 1, 2],
    defaultValue: 'SIN(0 1 1k)', valueLabel: 'Value',
    valueHint: '5 · SIN(offset amp freq) · PULSE(v1 v2 delay rise fall width period) · AC 1',
    card: (p, n) => `V${p.ref.slice(1)} ${n[0]} ${n[1]} ${spiceValue(p.value)}`,
  },
  I: {
    kind: 'I', label: 'Current source', group: 'Sources', prefix: 'I',
    pins: [{ name: '+', x: 0, y: -2 }, { name: '-', x: 0, y: 2 }],
    path: `M0 -2V-1M0 1V2M0 -0.6V0.6${circle(0, 0, 1)}`, solid: 'M0 0.7L-0.25 0.2H0.25Z', box: [-1, -2, 1, 2],
    defaultValue: '1m', valueLabel: 'Value', valueHint: 'Flows from the top pin through the source to the bottom pin',
    card: (p, n) => `I${p.ref.slice(1)} ${n[0]} ${n[1]} ${spiceValue(p.value)}`,
  },
  GND: {
    kind: 'GND', label: 'Ground', group: 'Connectivity', prefix: '', pins: [{ name: '0', x: 0, y: 0 }],
    path: 'M0 0V0.5M-0.6 0.5H0.6L0 1.1Z', box: [-0.6, 0, 0.6, 1.1],
    defaultValue: '', valueLabel: '', card: null,
  },
  LABEL: {
    kind: 'LABEL', label: 'Net label', group: 'Connectivity', prefix: '', pins: [{ name: 'net', x: 0, y: 0 }],
    path: 'M-0.15 -0.15H0.15V0.15H-0.15Z', box: [-0.2, -1.1, 2.4, 0.2],
    defaultValue: 'out', valueLabel: 'Net name', valueHint: 'Nets with the same name are connected',
    card: null,
  },
  PORT: {
    kind: 'PORT', label: 'Subcircuit port', group: 'Connectivity', prefix: '', pins: [{ name: 'port', x: 0, y: 0 }],
    path: 'M0 0L0.6 -0.6H2.2V0.6H0.6Z', box: [-0.2, -0.8, 5, 0.8],
    defaultValue: 'in', valueLabel: 'Port name', valueHint: 'How this connection appears on the subcircuit symbol. Order of placement = pin order',
    card: null,
  },
  SUBCKT: {
    kind: 'SUBCKT', label: 'Subcircuit', group: 'Subcircuits', prefix: 'X', pins: [],
    path: '', box: [-2, -2, 2, 2],
    defaultValue: '', valueLabel: 'Subcircuit', valueHint: 'Name of a subcircuit defined in this schematic',
    card: (p, n) => `X${p.ref.slice(1)} ${n.join(' ')} ${p.value.trim().replace(/\s+/g, '_')}`,
  },
  D: {
    kind: 'D', label: 'Diode', group: 'Semiconductors', prefix: 'D',
    pins: [{ name: 'A', x: 0, y: -2 }, { name: 'K', x: 0, y: 2 }],
    path: 'M0 -2V-0.5M0 0.5V2M-0.6 -0.5H0.6L0 0.5ZM-0.6 0.5H0.6', box: [-0.6, -2, 0.6, 2],
    defaultValue: 'DGEN', valueLabel: 'Model', valueHint: 'Built in: DGEN, LED_RED, ZENER_5V1',
    card: (p, n) => `D${p.ref.slice(1)} ${n[0]} ${n[1]} ${model(p)}`,
  },
  NPN: {
    kind: 'NPN', label: 'NPN transistor', group: 'Semiconductors', prefix: 'Q',
    pins: [{ name: 'C', x: 1, y: -2 }, { name: 'B', x: -2, y: 0 }, { name: 'E', x: 1, y: 2 }],
    path: `M-2 0H-0.4M-0.4 -0.9V0.9M-0.4 -0.35L1 -1.1V-2M-0.4 0.35L1 1.1V2${circle(0.15, 0, 1.35)}`,
    solid: 'M1 1.1L0.47 1.04L0.65 0.69Z', box: [-2, -2, 1.5, 2],
    defaultValue: 'NPN_GEN', valueLabel: 'Model', valueHint: 'Built in: NPN_GEN',
    card: (p, n) => `Q${p.ref.slice(1)} ${n[0]} ${n[1]} ${n[2]} ${model(p)}`,
  },
  PNP: {
    kind: 'PNP', label: 'PNP transistor', group: 'Semiconductors', prefix: 'Q',
    pins: [{ name: 'E', x: 1, y: -2 }, { name: 'B', x: -2, y: 0 }, { name: 'C', x: 1, y: 2 }],
    path: `M-2 0H-0.4M-0.4 -0.9V0.9M-0.4 -0.35L1 -1.1V-2M-0.4 0.35L1 1.1V2${circle(0.15, 0, 1.35)}`,
    solid: 'M-0.2 -0.46L0.33 -0.52L0.15 -0.87Z', box: [-2, -2, 1.5, 2],
    defaultValue: 'PNP_GEN', valueLabel: 'Model', valueHint: 'Built in: PNP_GEN',
    card: (p, n) => `Q${p.ref.slice(1)} ${n[2]} ${n[1]} ${n[0]} ${model(p)}`,
  },
  NMOS: {
    kind: 'NMOS', label: 'N-channel MOSFET', group: 'Semiconductors', prefix: 'M',
    pins: [{ name: 'D', x: 1, y: -2 }, { name: 'G', x: -2, y: 0 }, { name: 'S', x: 1, y: 2 }],
    path: 'M-2 0H-0.8M-0.8 -0.8V0.8M-0.4 -1V-0.4M-0.4 -0.3V0.3M-0.4 0.4V1M-0.4 -0.7H1V-2M-0.4 0.7H1V2M-0.4 0H1V0.7',
    solid: 'M-0.4 0L0.1 -0.22V0.22Z', box: [-2, -2, 1.2, 2],
    defaultValue: 'NMOS_GEN', valueLabel: 'Model', valueHint: 'Built in: NMOS_GEN. Body is tied to source.',
    card: (p, n) => `M${p.ref.slice(1)} ${n[0]} ${n[1]} ${n[2]} ${n[2]} ${model(p)}`,
  },
  PMOS: {
    kind: 'PMOS', label: 'P-channel MOSFET', group: 'Semiconductors', prefix: 'M',
    pins: [{ name: 'S', x: 1, y: -2 }, { name: 'G', x: -2, y: 0 }, { name: 'D', x: 1, y: 2 }],
    path: 'M-2 0H-0.8M-0.8 -0.8V0.8M-0.4 -1V-0.4M-0.4 -0.3V0.3M-0.4 0.4V1M-0.4 -0.7H1V-2M-0.4 0.7H1V2M-0.4 0H1V-0.7',
    solid: 'M0.6 0L0.1 -0.22V0.22Z', box: [-2, -2, 1.2, 2],
    defaultValue: 'PMOS_GEN', valueLabel: 'Model', valueHint: 'Built in: PMOS_GEN. Body is tied to source.',
    card: (p, n) => `M${p.ref.slice(1)} ${n[2]} ${n[1]} ${n[0]} ${n[0]} ${model(p)}`,
  },
  OPAMP: {
    kind: 'OPAMP', label: 'Op-amp (ideal)', group: 'Semiconductors', prefix: 'U',
    pins: [{ name: '+', x: -3, y: 1 }, { name: '-', x: -3, y: -1 }, { name: 'out', x: 3, y: 0 }],
    path: 'M-3 -1H-2M-3 1H-2M2 0H3M-1.75 -1H-1.25M-1.75 1H-1.25M-1.5 0.75V1.25', body: 'M-2 -2L2 0L-2 2Z',
    box: [-3, -2, 3, 2],
    defaultValue: '100k', valueLabel: 'Open-loop gain', valueHint: 'Ideal: no supply rails, no bandwidth limit',
    card: (p, n) => `E_${p.ref} ${n[2]} 0 ${n[0]} ${n[1]} ${spiceValue(p.value)}`,
  },
};

/** Generic device models, written for this project (not vendor data). Emitted only when a part uses them. */
export const MODELS: Record<string, string> = {
  DGEN: '.model DGEN D(Is=1e-14 N=1 Rs=0.5 Cjo=2p Tt=5n Bv=100)',
  LED_RED: '.model LED_RED D(Is=1e-18 N=2 Rs=2 Cjo=20p Bv=5)',
  ZENER_5V1: '.model ZENER_5V1 D(Is=1e-14 N=1 Rs=1 Bv=5.1 Ibv=5m Cjo=50p)',
  NPN_GEN: '.model NPN_GEN NPN(Is=1e-14 Bf=200 Vaf=100 Rb=10 Cje=5p Cjc=3p Tf=0.4n)',
  PNP_GEN: '.model PNP_GEN PNP(Is=1e-14 Bf=200 Vaf=100 Rb=10 Cje=5p Cjc=3p Tf=0.4n)',
  NMOS_GEN: '.model NMOS_GEN NMOS(Level=1 Vto=1.5 Kp=0.2 Lambda=0.01)',
  PMOS_GEN: '.model PMOS_GEN PMOS(Level=1 Vto=-1.5 Kp=0.1 Lambda=0.01)',
};

/** Symbol-local point -> schematic grid point (mirror about the vertical axis, then rotate clockwise). */
export function toWorld(part: Pick<Part, 'x' | 'y' | 'rot' | 'mirror'>, x: number, y: number): Point {
  const mx = part.mirror ? -x : x;
  switch (part.rot) {
    case 90: return { x: part.x - y, y: part.y + mx };
    case 180: return { x: part.x - mx, y: part.y - y };
    case 270: return { x: part.x + y, y: part.y - mx };
    default: return { x: part.x + mx, y: part.y + y };
  }
}

/** A subcircuit name SPICE will accept: letters, digits and underscore, not starting with a digit. */
export const SUBCKT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const generated = new Map<string, SymbolDef>();

/** The box-with-pins symbol for a subcircuit with these ports: half the pins down each side. */
export function subcktSymbol(ports: string[]): SymbolDef {
  const key = ports.join('\u0000');
  let def = generated.get(key);
  if (def) return def;
  const left = Math.ceil(ports.length / 2);
  const rows = Math.max(left, ports.length - left, 1);
  const y = (i: number) => 2 * i - (rows - 1);
  const pins: Pin[] = ports.map((name, i) => (i < left ? { name, x: -3, y: y(i) } : { name, x: 3, y: y(i - left) }));
  def = {
    ...SYMBOLS.SUBCKT, pins,
    path: pins.map((p) => `M${p.x} ${p.y}H${p.x < 0 ? -2 : 2}`).join(''),
    body: `M-2 ${-rows}H2V${rows}H-2Z`,
    box: [-3, -rows, 3, rows],
  };
  generated.set(key, def);
  return def;
}

/** The symbol for a placed part. Fixed for most kinds; built from `ports` for a subcircuit instance. */
export function symbolFor(part: Pick<Part, 'kind' | 'ports'>): SymbolDef {
  return part.kind === 'SUBCKT' ? subcktSymbol(part.ports ?? []) : SYMBOLS[part.kind];
}

export function pinPositions(part: Part): (Pin & Point)[] {
  return symbolFor(part).pins.map((pin) => ({ ...pin, ...toWorld(part, pin.x, pin.y) }));
}

/** Axis-aligned extent of a placed part, in grid units. */
export function partBox(part: Part): { x0: number; y0: number; x1: number; y1: number } {
  const [bx0, by0, bx1, by1] = symbolFor(part).box;
  const a = toWorld(part, bx0, by0);
  const b = toWorld(part, bx1, by1);
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** Lowest free designator for a prefix: R1, R2, … */
export function nextRef(parts: Part[], prefix: string): string {
  if (!prefix) return '';
  const used = new Set(parts.map((p) => p.ref.toUpperCase()));
  for (let k = 1; ; k++) if (!used.has(`${prefix}${k}`)) return `${prefix}${k}`;
}
