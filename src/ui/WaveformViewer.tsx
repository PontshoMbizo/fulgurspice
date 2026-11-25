// LTspice-style plot on the same panel as the other dock tabs: dotted grid, theme text colours,
// token trace colours that read on the plot background. Canvas 2D, redrawn whole on every change.
//
//  - one pane with voltages on the left axis and currents (or AC phase) on the right,
//    or "stacked": one pane per unit, sharing the time axis
//  - drag to zoom in x; wheel zooms y under the pointer, shift+wheel zooms x
//  - click places cursor A, then B; the readout shows both and the difference
//  - long traces are drawn as a min/max envelope per pixel column
//  - export the plot as PNG, the traces as CSV

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatSI, niceTicks } from '../core/units';
import { cursorDelta, envelopeIndices, interpAt, toCsv } from '../sim/analysis';
import type { SimResult } from '../sim/result';

// Colours are the --trace-N and --plot-* tokens in styles.css (light and dark), so the plot, the
// trace chips and the probe highlights on the sheet change together. DOM users take the var()
// as is; the canvas resolves it against the element's computed style on every draw.
const TRACE_COUNT = 8;
export const traceColor = (i: number) => `var(--trace-${(i % TRACE_COUNT) + 1})`;
const tokenReader = (el: Element) => {
  const cs = getComputedStyle(el);
  const tok = (name: string) => cs.getPropertyValue(name).trim();
  return { tok, col: (c: string) => { const m = /^var\((--[\w-]+)\)$/.exec(c); return m ? tok(m[1]) : c; } };
};

interface Series { label: string; color: string; axis: 'L' | 'R'; x: Float64Array; y: Float64Array; unit: string; dash: number[]; phase: boolean; pane: number }
interface Axis { min: number; max: number; ticks: number[]; unit: string }
interface PaneGeo { top: number; h: number; left: Axis | null; right: Axis | null }

const FONT = '11px "IBM Plex Mono", ui-monospace, monospace';
const M = { l: 62, r: 62, t: 24, b: 24 };
const GAP = 8;

const RUN_DASHES = [[], [7, 3], [2, 3], [8, 3, 2, 3], [4, 2], [1, 3]];

function buildSeries(result: SimResult, traces: string[], stacked: boolean): Series[] {
  const out: Series[] = [];
  // A sweep draws every run. One trace: a colour per run. Several: a colour per trace, a dash pattern per run.
  const runs = result.sweep ? result.sweep.runs : [result];
  runs.forEach((run, ri) => {
    const baseX = run.x!.re;
    const byRun = !!result.sweep && traces.length === 1;
    const suffix = result.sweep ? ` ${result.sweep.param}=${result.sweep.tags[ri]}` : '';
    const dash = result.sweep && !byRun ? RUN_DASHES[ri % RUN_DASHES.length] : [];
    const picked = traces.map((name, i) => ({ v: run.vectors.find((x) => x.name === name), color: traceColor(byRun ? ri : i) })).filter((t) => t.v);
    const mixed = picked.some((t) => t.v!.unit === 'A') && picked.some((t) => t.v!.unit !== 'A');
    for (const { v, color } of picked) {
      const x = v!.x ?? baseX;
      if (run.kind === 'ac' && v!.im) {
        const n = v!.re.length, db = new Float64Array(n), ph = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          db[i] = 20 * Math.log10(Math.max(Math.hypot(v!.re[i], v!.im[i]), 1e-30));
          ph[i] = (Math.atan2(v!.im[i], v!.re[i]) * 180) / Math.PI;
        }
        out.push({ label: `${v!.label}${suffix}`, color, axis: 'L', x, y: db, unit: 'dB', dash, phase: false, pane: 0 });
        out.push({ label: `${v!.label} phase${suffix}`, color, axis: 'R', x, y: ph, unit: '°', dash: [5, 4], phase: true, pane: 0 });
      } else {
        out.push({ label: `${v!.label}${suffix}`, color, axis: mixed && v!.unit === 'A' ? 'R' : 'L', x, y: v!.re, unit: v!.unit, dash, phase: false, pane: 0 });
      }
    }
  });
  if (stacked) {
    // one pane per unit, in the order the units first appear; everything on the left axis
    const units: string[] = [];
    for (const s of out) { if (!units.includes(s.unit)) units.push(s.unit); s.pane = units.indexOf(s.unit); s.axis = 'L'; }
  }
  return out;
}

/** First index with x[i] >= value. */
function lowerBound(x: ArrayLike<number>, value: number): number {
  let lo = 0, hi = x.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

function niceAxis(min: number, max: number, unit: string): Axis {
  if (!Number.isFinite(min)) { min = 0; max = 1; }
  if (max - min < Math.max(Math.abs(max), Math.abs(min), 1e-12) * 1e-6) { const pad = Math.abs(max) * 0.1 || 1; min -= pad; max += pad; }
  const ticks = niceTicks(min, max, 6);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : max - min;
  const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
  return { min: lo, max: hi, ticks: niceTicks(lo, hi, 6), unit };
}

function autoAxis(series: Series[], x0: number, x1: number, unit: string): Axis | null {
  if (!series.length) return null;
  let min = Infinity, max = -Infinity;
  for (const s of series) {
    const i0 = Math.max(0, lowerBound(s.x, x0) - 1), i1 = Math.min(s.x.length - 1, lowerBound(s.x, x1));
    for (let i = i0; i <= i1; i++) { const v = s.y[i]; if (v < min) min = v; if (v > max) max = v; }
  }
  return niceAxis(min, max, unit);
}

const download = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

interface Props {
  result: SimResult;
  traces: string[];
  stacked: boolean;
  onStacked: (v: boolean) => void;
  /** Base name for exported files. */
  fileBase: string;
}

export function WaveformViewer({ result, traces, stacked, onStacked, fileBase }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [range, setRange] = useState<[number, number] | null>(null);
  const [yRange, setYRange] = useState<Record<string, [number, number]>>({});
  const [hover, setHover] = useState<number | null>(null);
  const [zoomBox, setZoomBox] = useState<[number, number] | null>(null);
  const [cursors, setCursors] = useState<number[]>([]);
  const geo = useRef<{ panes: PaneGeo[]; x0: number; x1: number; pw: number } | null>(null);
  const down = useRef<number | null>(null);
  // The plot reads its colours from CSS: redraw when the system switches between light and dark.
  const [, setScheme] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const redraw = () => setScheme((n) => n + 1);
    mq.addEventListener('change', redraw);
    return () => mq.removeEventListener('change', redraw);
  }, []);

  const log = result.kind === 'ac';
  const series = useMemo(() => buildSeries(result, traces, stacked), [result, traces, stacked]);
  useEffect(() => { setRange(null); setYRange({}); setHover(null); setCursors([]); }, [result]);
  useEffect(() => { setYRange({}); }, [stacked, traces]);

  // Measure before first paint (the viewer remounts on every tab switch), then track resizes.
  useLayoutEffect(() => {
    const el = wrap.current!;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const baseX = result.x!.re;
  const lo = series.length ? Math.min(...series.map((s) => s.x[0])) : baseX[0];
  const hi = series.length ? Math.max(...series.map((s) => s.x[s.x.length - 1])) : baseX[baseX.length - 1];
  const [x0, x1] = range ?? [lo, hi];
  const pw = Math.max(10, size.w - M.l - M.r), ph = Math.max(10, size.h - M.t - M.b);
  const tx = (v: number) => (log ? Math.log10(v / x0) / Math.log10(x1 / x0) : (v - x0) / (x1 - x0));
  const fromPx = (px: number) => { const f = Math.min(1, Math.max(0, (px - M.l) / pw)); return log ? x0 * (x1 / x0) ** f : x0 + f * (x1 - x0); };
  const xLabel = log ? 'f' : result.kind === 'dc' ? 'x' : 't';
  const xUnit = result.x!.unit;

  useEffect(() => {
    const cv = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr); cv.height = Math.round(size.h * dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { tok, col } = tokenReader(cv);
    const INK = tok('--plot-ink'), INK2 = tok('--plot-text'), GRID = tok('--plot-grid'), FRAME = tok('--plot-frame');
    g.fillStyle = tok('--plot'); g.fillRect(0, 0, size.w, size.h);
    geo.current = null;
    if (size.w < 160 || size.h < 80 || !(x1 > x0)) return;

    const X = (v: number) => M.l + tx(v) * pw;
    const nPanes = Math.max(1, ...series.map((s) => s.pane + 1));
    const paneH = (ph - GAP * (nPanes - 1)) / nPanes;
    const panes: PaneGeo[] = [];
    for (let p = 0; p < nPanes; p++) {
      const mine = series.filter((s) => s.pane === p);
      const unitOf = (side: 'L' | 'R') => mine.find((s) => s.axis === side)?.unit ?? '';
      const auto = (side: 'L' | 'R') => autoAxis(mine.filter((s) => s.axis === side), x0, x1, unitOf(side));
      const over = (side: 'L' | 'R', a: Axis | null): Axis | null => {
        const o = yRange[`${p}${side}`];
        return a && o ? { min: o[0], max: o[1], ticks: niceTicks(o[0], o[1], 6), unit: a.unit } : a;
      };
      panes.push({ top: M.t + p * (paneH + GAP), h: paneH, left: over('L', auto('L')), right: over('R', auto('R')) });
    }
    geo.current = { panes, x0, x1, pw };
    const Y = (pn: PaneGeo, a: Axis, v: number) => pn.top + (1 - (v - a.min) / (a.max - a.min)) * pn.h;

    g.font = FONT; g.lineWidth = 1;
    const xticks: number[] = [];
    if (log) for (let d = Math.ceil(Math.log10(x0) - 1e-9); d <= Math.log10(x1) + 1e-9; d++) xticks.push(10 ** d);
    else xticks.push(...niceTicks(x0, x1, Math.max(3, Math.floor(pw / 90))));

    panes.forEach((pn, p) => {
      // grid
      g.strokeStyle = GRID; g.setLineDash([1, 3]);
      g.beginPath();
      for (const t of xticks) { const px = Math.round(X(t)) + 0.5; g.moveTo(px, pn.top); g.lineTo(px, pn.top + pn.h); }
      const ya = pn.left ?? pn.right;
      if (ya) for (const t of ya.ticks) { const py = Math.round(Y(pn, ya, t)) + 0.5; g.moveTo(M.l, py); g.lineTo(M.l + pw, py); }
      g.stroke(); g.setLineDash([]);
      g.strokeStyle = FRAME; g.strokeRect(M.l + 0.5, pn.top + 0.5, pw, pn.h);
      // y labels
      g.fillStyle = INK2; g.textBaseline = 'middle';
      g.textAlign = 'right';
      if (pn.left) for (const t of pn.left.ticks) g.fillText(formatSI(t, pn.left.unit, 3), M.l - 6, Y(pn, pn.left, t));
      g.textAlign = 'left';
      if (pn.right) for (const t of pn.right.ticks) g.fillText(formatSI(t, pn.right.unit, 3), M.l + pw + 6, Y(pn, pn.right, t));
      // traces
      g.save(); g.beginPath(); g.rect(M.l, pn.top, pw, pn.h); g.clip();
      g.lineWidth = 1.5; g.lineJoin = 'round';
      for (const s of series) {
        if (s.pane !== p) continue;
        const a = s.axis === 'L' ? pn.left : pn.right;
        if (!a) continue;
        const i0 = Math.max(0, lowerBound(s.x, x0) - 1), i1 = Math.min(s.x.length - 1, lowerBound(s.x, x1));
        g.strokeStyle = col(s.color); g.setLineDash(s.dash);
        g.beginPath();
        let first = true;
        for (const i of envelopeIndices(s.y, i0, i1, Math.round(pw))) {
          const px = X(s.x[i]), py = Y(pn, a, s.y[i]);
          if (first) { g.moveTo(px, py); first = false; } else g.lineTo(px, py);
        }
        g.stroke();
      }
      g.setLineDash([]);
      if (zoomBox) {
        const lo2 = Math.min(zoomBox[0], zoomBox[1]), hi2 = Math.max(zoomBox[0], zoomBox[1]);
        g.fillStyle = tok('--plot-zoom'); g.fillRect(lo2, pn.top, hi2 - lo2, pn.h);
      }
      g.restore();
    });

    g.fillStyle = INK2; g.textBaseline = 'top'; g.textAlign = 'center';
    for (const t of xticks) g.fillText(formatSI(t, xUnit, 3), X(t), M.t + ph + 6);

    // trace names across the top, as LTspice does
    g.textBaseline = 'middle'; g.textAlign = 'left';
    const names = series.filter((s) => !s.phase);
    const widths = names.map((s) => g.measureText(s.label).width + 18);
    let nx = M.l + Math.max(0, (pw - widths.reduce((a, b) => a + b, 0)) / 2);
    names.forEach((s, i) => { g.fillStyle = col(s.color); g.fillText(s.label, nx, M.t / 2 + 1); nx += widths[i]; });

    const box = (rows: { text: string; color: string }[], bx: number, by: number) => {
      const bw = Math.max(...rows.map((r) => g.measureText(r.text).width)) + 16, bh = rows.length * 15 + 8;
      const px = Math.min(Math.max(M.l + 4, bx), M.l + pw - bw - 4);
      g.fillStyle = tok('--plot-readout'); g.fillRect(px, by, bw, bh); g.strokeStyle = FRAME; g.strokeRect(px + 0.5, by + 0.5, bw, bh);
      g.textAlign = 'left'; g.textBaseline = 'top';
      rows.forEach((r, n) => { g.fillStyle = col(r.color); g.fillText(r.text, px + 8, by + 6 + n * 15); });
    };
    const vline = (xv: number, color: string, dash: number[], label?: string) => {
      const px = Math.round(X(xv)) + 0.5;
      if (px < M.l || px > M.l + pw) return;
      g.strokeStyle = color; g.setLineDash(dash); g.beginPath(); g.moveTo(px, M.t); g.lineTo(px, M.t + ph); g.stroke(); g.setLineDash([]);
      if (label) { g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(label, px, M.t - 1); }
    };

    if (cursors.length) {
      cursors.forEach((c, i) => vline(c, tok(i === 0 ? '--cursor-a' : '--cursor-b'), [], i === 0 ? 'A' : 'B'));
      const xs = `${xLabel} =`;
      const rows: { text: string; color: string }[] = [];
      if (cursors.length === 2) {
        const d = cursorDelta(series, cursors[0], cursors[1]);
        rows.push({ text: `A ${xs} ${formatSI(cursors[0], xUnit)}   B ${xs} ${formatSI(cursors[1], xUnit)}`, color: INK });
        rows.push({ text: `Δ${xLabel} = ${formatSI(d.dx, xUnit)}${!log && d.inverse !== null && xUnit === 's' ? `   1/Δ${xLabel} = ${formatSI(d.inverse, 'Hz')}` : ''}`, color: INK });
        series.forEach((s, i) => rows.push({ text: `${s.label}   A ${formatSI(d.rows[i].a, s.unit)}   B ${formatSI(d.rows[i].b, s.unit)}   Δ ${formatSI(d.rows[i].delta, s.unit)}`, color: s.color }));
      } else {
        rows.push({ text: `A ${xs} ${formatSI(cursors[0], xUnit)}   (click again for B)`, color: INK });
        series.forEach((s) => rows.push({ text: `${s.label} = ${formatSI(interpAt(s.x, s.y, cursors[0]), s.unit)}`, color: s.color }));
      }
      box(rows, M.l + pw, M.t + 8);
    } else if (hover !== null && !zoomBox) {
      const xv = fromPx(hover);
      vline(xv, tok('--plot-hover'), [4, 3]);
      const rows = [{ text: `${xLabel} = ${formatSI(xv, xUnit)}`, color: INK }, ...series.map((s) => ({ text: `${s.label} = ${formatSI(interpAt(s.x, s.y, xv), s.unit)}`, color: s.color }))];
      const bw = Math.max(...rows.map((r) => g.measureText(r.text).width)) + 16;
      const px = M.l + (hover - M.l);
      box(rows, px + 10 + bw > M.l + pw ? px - 10 - bw : px + 10, M.t + 8);
    }
  }); // redraw after every render: cheap, and never stale

  // Wheel: zoom y under the pointer; with shift, zoom x. Registered by hand, as React's listener is passive.
  const state = useRef({ x0, x1, log });
  state.current = { x0, x1, log };
  useEffect(() => {
    const cv = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      const gm = geo.current;
      if (!gm) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const f = e.deltaY > 0 ? 1.25 : 0.8;
      if (e.shiftKey) {
        const { x0: a, x1: b, log: lg } = state.current;
        const t = Math.min(1, Math.max(0, (px - M.l) / gm.pw));
        if (lg) { const la = Math.log10(a), lb = Math.log10(b), c = la + t * (lb - la); setRange([10 ** (c - (c - la) * f), 10 ** (c + (lb - c) * f)]); }
        else { const c = a + t * (b - a); setRange([c - (c - a) * f, c + (b - c) * f]); }
        return;
      }
      const p = gm.panes.findIndex((pn) => py >= pn.top && py <= pn.top + pn.h);
      if (p < 0) return;
      const pn = gm.panes[p];
      const frac = 1 - (py - pn.top) / pn.h;
      setYRange((old) => {
        const next = { ...old };
        for (const side of ['L', 'R'] as const) {
          const a = side === 'L' ? pn.left : pn.right;
          if (!a) continue;
          const v = a.min + frac * (a.max - a.min);
          next[`${p}${side}`] = [v - (v - a.min) * f, v + (a.max - v) * f];
        }
        return next;
      });
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, []);

  const localX = (e: React.PointerEvent) => e.clientX - canvas.current!.getBoundingClientRect().left;
  const traceNames = traces.filter((n) => result.vectors.some((v) => v.name === n));
  const base = fileBase.trim().replace(/[^\w.-]+/g, '-') || 'waveform';
  const savePng = () => canvas.current!.toBlob((b) => { if (b) download(`${base}.png`, b); });
  const saveCsv = () => download(`${base}.csv`, new Blob([toCsv(result, traceNames)], { type: 'text/csv' }));

  return (
    <div className="plot" ref={wrap}>
      <canvas
        ref={canvas}
        onPointerMove={(e) => { const px = localX(e); setHover(px); if (zoomBox) setZoomBox([zoomBox[0], px]); }}
        onPointerLeave={() => { setHover(null); }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); const px = localX(e); down.current = px; setZoomBox([px, px]); }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          const px = localX(e), start = down.current;
          if (zoomBox && Math.abs(zoomBox[1] - zoomBox[0]) > 6) {
            const a = fromPx(Math.min(zoomBox[0], zoomBox[1])), b = fromPx(Math.max(zoomBox[0], zoomBox[1]));
            if (b > a) setRange([a, b]);
          } else if (start !== null && Math.abs(px - start) <= 4 && px >= M.l && px <= M.l + pw) {
            // a click, not a drag: place A, then B, then start over
            const xv = fromPx(px);
            setCursors((c) => (c.length === 1 ? [c[0], xv] : [xv]));
          }
          setZoomBox(null); down.current = null;
        }}
        onDoubleClick={() => { setRange(null); setYRange({}); setCursors([]); }}
        onContextMenu={(e) => { e.preventDefault(); setCursors([]); }}
      />
      <div className="plot-tools">
        <button type="button" className="btn" aria-pressed={stacked} title="One pane per unit, sharing the time axis" onClick={() => onStacked(!stacked)}>Stack</button>
        <button type="button" className="btn" title="Save the traces as CSV" disabled={!traceNames.length} onClick={saveCsv}>CSV</button>
        <button type="button" className="btn" title="Save the plot as an image" onClick={savePng}>PNG</button>
      </div>
      {series.length === 0 && <div className="plot-empty">No traces. Pick one from “Add trace”, or use the probe tool on the schematic.</div>}
    </div>
  );
}
