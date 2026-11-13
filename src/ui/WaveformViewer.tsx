// LTspice-style plot: black field, dotted grid, voltages on the left axis and
// currents (or AC phase) on the right. Canvas 2D, redrawn whole on every change.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatSI, niceTicks } from '../core/units';
import type { SimResult } from '../sim/result';

const COLORS = ['#ffe600', '#40c4ff', '#ff6ec7', '#7cfc6a', '#ff9a3c', '#b39dff', '#ffffff', '#ff5252'];
export const traceColor = (i: number) => COLORS[i % COLORS.length];

interface Series { label: string; color: string; axis: 'L' | 'R'; y: Float64Array; unit: string; dashed: boolean }
interface Axis { min: number; max: number; ticks: number[]; unit: string }

const FONT = '11px "IBM Plex Mono", ui-monospace, monospace';
const M = { l: 62, r: 62, t: 24, b: 24 };

function buildSeries(result: SimResult, traces: string[]): Series[] {
  const out: Series[] = [];
  const picked = traces.map((name, i) => ({ v: result.vectors.find((x) => x.name === name), color: traceColor(i) })).filter((t) => t.v);
  const mixed = picked.some((t) => t.v!.unit === 'A') && picked.some((t) => t.v!.unit !== 'A');
  for (const { v, color } of picked) {
    if (result.kind === 'ac' && v!.im) {
      const n = v!.re.length, db = new Float64Array(n), ph = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        db[i] = 20 * Math.log10(Math.max(Math.hypot(v!.re[i], v!.im[i]), 1e-30));
        ph[i] = (Math.atan2(v!.im[i], v!.re[i]) * 180) / Math.PI;
      }
      out.push({ label: v!.label, color, axis: 'L', y: db, unit: 'dB', dashed: false });
      out.push({ label: `${v!.label} phase`, color, axis: 'R', y: ph, unit: '°', dashed: true });
    } else {
      out.push({ label: v!.label, color, axis: mixed && v!.unit === 'A' ? 'R' : 'L', y: v!.re, unit: v!.unit, dashed: false });
    }
  }
  return out;
}

function axisFor(series: Series[], side: 'L' | 'R', i0: number, i1: number): Axis | null {
  const mine = series.filter((s) => s.axis === side);
  if (!mine.length) return null;
  let min = Infinity, max = -Infinity;
  for (const s of mine) for (let i = i0; i <= i1; i++) { const v = s.y[i]; if (v < min) min = v; if (v > max) max = v; }
  if (!Number.isFinite(min)) { min = 0; max = 1; }
  if (max - min < Math.max(Math.abs(max), Math.abs(min), 1e-12) * 1e-6) { const pad = Math.abs(max) * 0.1 || 1; min -= pad; max += pad; }
  const ticks = niceTicks(min, max, 6);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : max - min;
  const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
  return { min: lo, max: hi, ticks: niceTicks(lo, hi, 6), unit: mine[0].unit };
}

/** First index with x[i] >= value. */
function lowerBound(x: Float64Array, value: number): number {
  let lo = 0, hi = x.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

interface Props { result: SimResult; traces: string[] }

export function WaveformViewer({ result, traces }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [range, setRange] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [zoomBox, setZoomBox] = useState<[number, number] | null>(null);

  const x = result.x!.re;
  const log = result.kind === 'ac';
  const series = useMemo(() => buildSeries(result, traces), [result, traces]);
  useEffect(() => { setRange(null); setHover(null); }, [result]);

  // Measure before first paint (the viewer remounts on every tab switch), then track resizes.
  useLayoutEffect(() => {
    const el = wrap.current!;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const full: [number, number] = [x[0], x[x.length - 1]];
  const [x0, x1] = range ?? full;
  const pw = Math.max(10, size.w - M.l - M.r), ph = Math.max(10, size.h - M.t - M.b);
  const tx = (v: number) => (log ? Math.log10(v / x0) / Math.log10(x1 / x0) : (v - x0) / (x1 - x0));
  const fromPx = (px: number) => { const f = Math.min(1, Math.max(0, (px - M.l) / pw)); return log ? x0 * (x1 / x0) ** f : x0 + f * (x1 - x0); };

  useEffect(() => {
    const cv = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr); cv.height = Math.round(size.h * dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, size.w, size.h);
    if (size.w < 160 || size.h < 80 || !(x1 > x0)) return;

    const i0 = Math.max(0, lowerBound(x, x0) - 1), i1 = Math.min(x.length - 1, lowerBound(x, x1));
    const left = axisFor(series, 'L', i0, i1), right = axisFor(series, 'R', i0, i1);
    const X = (v: number) => M.l + tx(v) * pw;
    const Y = (a: Axis, v: number) => M.t + (1 - (v - a.min) / (a.max - a.min)) * ph;

    g.font = FONT; g.lineWidth = 1;
    // grid
    g.strokeStyle = '#6e6e6e'; g.setLineDash([1, 3]);
    const xticks: number[] = [];
    if (log) for (let d = Math.ceil(Math.log10(x0) - 1e-9); d <= Math.log10(x1) + 1e-9; d++) xticks.push(10 ** d);
    else xticks.push(...niceTicks(x0, x1, Math.max(3, Math.floor(pw / 90))));
    g.beginPath();
    for (const t of xticks) { const px = Math.round(X(t)) + 0.5; g.moveTo(px, M.t); g.lineTo(px, M.t + ph); }
    const ya = left ?? right;
    if (ya) for (const t of ya.ticks) { const py = Math.round(Y(ya, t)) + 0.5; g.moveTo(M.l, py); g.lineTo(M.l + pw, py); }
    g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#9a9a9a'; g.strokeRect(M.l + 0.5, M.t + 0.5, pw, ph);

    // tick labels
    g.fillStyle = '#d4d4d4'; g.textBaseline = 'middle';
    g.textAlign = 'right';
    if (left) for (const t of left.ticks) g.fillText(formatSI(t, left.unit, 3), M.l - 6, Y(left, t));
    g.textAlign = 'left';
    if (right) for (const t of right.ticks) g.fillText(formatSI(t, right.unit, 3), M.l + pw + 6, Y(right, t));
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const t of xticks) g.fillText(formatSI(t, result.x!.unit, 3), X(t), M.t + ph + 6);

    // traces
    g.save(); g.beginPath(); g.rect(M.l, M.t, pw, ph); g.clip();
    g.lineWidth = 1.5; g.lineJoin = 'round';
    for (const s of series) {
      const a = s.axis === 'L' ? left! : right!;
      g.strokeStyle = s.color; g.setLineDash(s.dashed ? [5, 4] : []);
      g.beginPath();
      for (let i = i0; i <= i1; i++) { const px = X(x[i]), py = Y(a, s.y[i]); if (i === i0) g.moveTo(px, py); else g.lineTo(px, py); }
      g.stroke();
    }
    g.setLineDash([]);
    if (zoomBox) {
      const a = Math.min(zoomBox[0], zoomBox[1]), b = Math.max(zoomBox[0], zoomBox[1]);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(a, M.t, b - a, ph);
    }
    g.restore();

    // trace names across the top, as LTspice does
    g.textBaseline = 'middle'; g.textAlign = 'left';
    const names = series.filter((s) => !s.dashed);
    const widths = names.map((s) => g.measureText(s.label).width + 18);
    let nx = M.l + Math.max(0, (pw - widths.reduce((a, b) => a + b, 0)) / 2);
    names.forEach((s, i) => { g.fillStyle = s.color; g.fillText(s.label, nx, M.t / 2 + 1); nx += widths[i]; });

    // cursor readout
    if (hover !== null && !zoomBox) {
      const xv = fromPx(hover);
      const i = Math.min(x.length - 1, Math.max(0, lowerBound(x, xv)));
      const k = i > 0 && Math.abs(x[i - 1] - xv) < Math.abs(x[i] - xv) ? i - 1 : i;
      const px = Math.round(X(x[k])) + 0.5;
      g.strokeStyle = '#b0b0b0'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(px, M.t); g.lineTo(px, M.t + ph); g.stroke(); g.setLineDash([]);
      const rows = [`${log ? 'f' : result.kind === 'dc' ? 'x' : 't'} = ${formatSI(x[k], result.x!.unit)}`, ...series.map((s) => `${s.label} = ${formatSI(s.y[k], s.unit)}`)];
      const bw = Math.max(...rows.map((r) => g.measureText(r).width)) + 16, bh = rows.length * 15 + 8;
      const bx = px + 10 + bw > M.l + pw ? px - 10 - bw : px + 10, by = M.t + 8;
      g.fillStyle = 'rgba(20,20,20,0.92)'; g.fillRect(bx, by, bw, bh); g.strokeStyle = '#8a8a8a'; g.strokeRect(bx + 0.5, by + 0.5, bw, bh);
      g.textAlign = 'left'; g.textBaseline = 'top';
      rows.forEach((r, n) => { g.fillStyle = n === 0 ? '#d4d4d4' : series[n - 1].color; g.fillText(r, bx + 8, by + 6 + n * 15); });
    }
  }); // redraw after every render: cheap, and never stale

  const localX = (e: React.PointerEvent) => e.clientX - canvas.current!.getBoundingClientRect().left;
  return (
    <div className="plot" ref={wrap}>
      <canvas
        ref={canvas}
        onPointerMove={(e) => { const px = localX(e); setHover(px); if (zoomBox) setZoomBox([zoomBox[0], px]); }}
        onPointerLeave={() => { setHover(null); }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); const px = localX(e); setZoomBox([px, px]); }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          if (zoomBox && Math.abs(zoomBox[1] - zoomBox[0]) > 6) {
            const a = fromPx(Math.min(zoomBox[0], zoomBox[1])), b = fromPx(Math.max(zoomBox[0], zoomBox[1]));
            if (b > a) setRange([a, b]);
          }
          setZoomBox(null);
        }}
        onDoubleClick={() => setRange(null)}
      />
      {series.length === 0 && <div className="plot-empty">No traces. Pick one from “Add trace”, or use the probe tool on the schematic.</div>}
    </div>
  );
}
