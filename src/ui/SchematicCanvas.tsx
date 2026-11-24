// The schematic sheet. One SVG; all geometry is in grid units scaled by G, so a
// pin is on a wire exactly when their integer coordinates say so.

import { useEffect, useMemo, useRef, useState } from 'react';
import { route } from '../core/geometry';
import type { Compiled } from '../core/netlist';
import { onWire } from '../core/netlist';
import { SYMBOLS, partBox, pinPositions, symbolFor, toWorld } from '../core/symbols';
import type { Part, PartKind, Point, Rot, Schematic } from '../core/types';
import { formatSI } from '../core/units';
import { addPart, addWires, moveItems } from './store';

export const G = 10;
export type Tool = 'select' | 'wire' | 'place' | 'probe';
/** What the place tool is carrying. `value` and `ports` are set for a subcircuit instance. */
export interface Placing { kind: PartKind; rot: Rot; mirror: boolean; value?: string; ports?: string[] }
export type ProbeTarget = { node: string } | { part: Part };

interface Props {
  sch: Schematic;
  compiled: Compiled;
  selection: Set<string>;
  tool: Tool;
  placing: Placing | null;
  /** node name -> trace colour, for nets currently plotted */
  probeColors: Map<string, string>;
  /** node name -> volts, after an operating-point run */
  opValues: Map<string, number> | null;
  errorParts: Set<string>;
  fitToken: number;
  onCommit: (sch: Schematic) => void;
  onSelect: (ids: string[]) => void;
  onProbe: (target: ProbeTarget) => void;
  onCancel: () => void;
  onCursor: (p: Point | null) => void;
  onZoom: (zoom: number) => void;
  /** Double-click on a subcircuit instance. */
  onOpenSubckt?: (name: string) => void;
}

interface View { panX: number; panY: number; zoom: number }
type Drag =
  | { type: 'pan'; sx: number; sy: number; panX: number; panY: number; moved: boolean }
  | { type: 'move'; start: Point; ids: Set<string> }
  | { type: 'marquee'; start: Point; additive: boolean }
  | { type: 'label'; start: Point; id: string; which: 'ref' | 'value' };

/** Does a box (possibly reversed start/end) select this item's extent? Dragging
 * left-to-right only takes items fully inside the box (KiCad's convention);
 * right-to-left takes anything the box touches. */
function marqueeHits(start: Point, end: Point, bx0: number, by0: number, bx1: number, by1: number): boolean {
  const x0 = Math.min(start.x, end.x), x1 = Math.max(start.x, end.x);
  const y0 = Math.min(start.y, end.y), y1 = Math.max(start.y, end.y);
  return start.x <= end.x
    ? bx0 >= x0 && bx1 <= x1 && by0 >= y0 && by1 <= y1
    : bx0 <= x1 && bx1 >= x0 && by0 <= y1 && by1 >= y0;
}

/** The part with its reference or value text nudged by `by` grid units more. */
export function withLabelOffset(sch: Schematic, id: string, which: 'ref' | 'value', by: Point): Schematic {
  const key = which === 'ref' ? 'refOffset' : 'valueOffset';
  return { ...sch, parts: sch.parts.map((p) => (p.id === id ? { ...p, [key]: { x: (p[key]?.x ?? 0) + by.x, y: (p[key]?.y ?? 0) + by.y } } : p)) };
}

function PartView({ part, selected, error, ghost, open }: { part: Part; selected?: boolean; error?: boolean; ghost?: boolean; open?: Point[] }) {
  const def = symbolFor(part);
  const [bx0, by0, bx1, by1] = def.box;
  const b = partBox(part);
  const cx = ((b.x0 + b.x1) / 2) * G, cy = ((b.y0 + b.y1) / 2) * G;
  const tall = b.y1 - b.y0 >= b.x1 - b.x0;
  const ro = part.refOffset ?? { x: 0, y: 0 }, vo = part.valueOffset ?? { x: 0, y: 0 };
  const cls = `part${selected ? ' is-selected' : ''}${error ? ' has-error' : ''}${ghost ? ' is-ghost' : ''}`;
  return (
    <g className={cls} data-id={ghost ? undefined : part.id} data-kind="part">
      <g transform={`translate(${part.x * G} ${part.y * G}) rotate(${part.rot}) scale(${part.mirror ? -G : G} ${G})`}>
        {def.body && <path className="sym-body" d={def.body} />}
        <path className="sym" d={def.path} />
        {def.solid && <path className="sym-solid" d={def.solid} />}
        <rect className="part-hit" x={bx0 - 0.3} y={by0 - 0.3} width={bx1 - bx0 + 0.6} height={by1 - by0 + 0.6} />
      </g>
      {open?.map((p) => <circle key={`${p.x},${p.y}`} className="pin-open" cx={p.x * G} cy={p.y * G} r={2.2} />)}
      {part.kind === 'LABEL' && <text className="net-label" data-label="value" x={part.x * G + 5 + vo.x * G} y={part.y * G - 5 + vo.y * G}>{part.value}</text>}
      {part.kind === 'PORT' && (() => {
        // The name sits beyond the arrow, on whichever side mirroring and rotation put it.
        const end = toWorld(part, 2.6, 0), dx = end.x - part.x, dy = end.y - part.y;
        return <text className="net-label" data-label="value" textAnchor={dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle'} x={end.x * G + vo.x * G} y={end.y * G + (dy === 0 ? 3 : dy > 0 ? 9 : -3) + vo.y * G}>{part.value}</text>;
      })()}
      {part.kind === 'SUBCKT' && def.pins.map((pin) => {
        // Name each pin just inside the box. The text stays upright whatever the rotation.
        const inward = toWorld(part, pin.x + (pin.x < 0 ? 1.8 : -1.8), pin.y);
        return <text key={pin.name} className="pin-name" textAnchor="middle" x={inward.x * G} y={inward.y * G + 3}>{pin.name}</text>;
      })}
      {def.prefix && (tall ? (
        <>
          <text className="part-ref" data-label="ref" x={b.x1 * G + 4 + ro.x * G} y={cy - 2 + ro.y * G}>{part.ref}</text>
          <text className="part-value" data-label="value" x={b.x1 * G + 4 + vo.x * G} y={cy + 10 + vo.y * G}>{part.value}</text>
        </>
      ) : (
        <>
          <text className="part-ref" data-label="ref" textAnchor="middle" x={cx + ro.x * G} y={b.y0 * G - 4 + ro.y * G}>{part.ref}</text>
          <text className="part-value" data-label="value" textAnchor="middle" x={cx + vo.x * G} y={b.y1 * G + 12 + vo.y * G}>{part.value}</text>
        </>
      ))}
    </g>
  );
}

export function SchematicCanvas(props: Props) {
  const { sch, compiled, selection, tool, placing } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ panX: 40, panY: 30, zoom: 2 });
  const [cursor, setCursor] = useState<Point | null>(null);
  const [draft, setDraft] = useState<Point | null>(null);
  const [delta, setDelta] = useState<Point>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [marqueeEnd, setMarqueeEnd] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<Drag | null>(null);

  const gridAt = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left - view.panX) / (view.zoom * G)),
      y: Math.round((e.clientY - r.top - view.panY) / (view.zoom * G)),
    };
  };

  /** Unrounded position in the same units the scene is drawn in (x*G), i.e. grid
   * units times G, before rounding to a grid point. Used for the marquee box so
   * it can be dragged smoothly instead of jumping grid cell to grid cell. */
  const sceneAt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.panX) / view.zoom, y: (e.clientY - r.top - view.panY) / view.zoom };
  };

  useEffect(() => { if (tool !== 'wire') setDraft(null); }, [tool]);
  useEffect(() => { props.onZoom(view.zoom); }, [view.zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom to fit whenever the app asks (new document, View > Fit).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const xs: number[] = [], ys: number[] = [];
    for (const p of sch.parts) { const b = partBox(p); xs.push(b.x0, b.x1); ys.push(b.y0, b.y1); }
    for (const w of sch.wires) { xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); }
    const { width, height } = svg.getBoundingClientRect();
    if (!xs.length || !width || !height) { setView({ panX: 40, panY: 30, zoom: 2 }); return; }
    const x0 = Math.min(...xs) - 4, x1 = Math.max(...xs) + 6, y0 = Math.min(...ys) - 4, y1 = Math.max(...ys) + 4;
    const zoom = Math.max(0.5, Math.min(3, width / ((x1 - x0) * G), height / ((y1 - y0) * G)));
    setView({ zoom, panX: (width - (x0 + x1) * G * zoom) / 2, panY: (height - (y0 + y1) * G * zoom) / 2 });
  }, [props.fitToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zoom about the pointer. Registered by hand: React's wheel listener is passive.
  useEffect(() => {
    const svg = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const zoom = Math.max(0.4, Math.min(8, v.zoom * Math.exp(-e.deltaY * 0.0015)));
        const k = zoom / v.zoom;
        return { zoom, panX: mx - (mx - v.panX) * k, panY: my - (my - v.panY) * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const connectable = (p: Point) =>
    sch.parts.some((part) => pinPositions(part).some((pin) => pin.x === p.x && pin.y === p.y)) || sch.wires.some((w) => onWire(w, p.x, p.y));

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = gridAt(e);
    const startPan = () => {
      drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, panX: view.panX, panY: view.panY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    if (e.button === 1) { e.preventDefault(); startPan(); return; }
    if (e.button !== 0) return;
    const hitEl = (e.target as Element).closest('[data-id]');
    const hit = hitEl?.getAttribute('data-id') ?? null;

    if (tool === 'place' && placing) {
      const next = addPart(sch, placing.kind, p.x, p.y, placing.rot, placing.mirror, { value: placing.value, ports: placing.ports });
      props.onCommit(next.sch);
      return;
    }
    if (tool === 'wire') {
      if (!draft) { setDraft(p); return; }
      if (draft.x === p.x && draft.y === p.y) { setDraft(null); return; }
      const lands = connectable(p);
      props.onCommit(addWires(sch, route(draft, p)));
      setDraft(lands ? null : p);
      return;
    }
    if (tool === 'probe') {
      if (!hit) return;
      if (hitEl!.getAttribute('data-kind') === 'wire') { const node = compiled.wireNode.get(hit); if (node) props.onProbe({ node }); }
      else { const part = sch.parts.find((x) => x.id === hit); if (part) props.onProbe(part.kind === 'LABEL' || part.kind === 'GND' ? { node: compiled.pinNode.get(`${part.id}:${SYMBOLS[part.kind].pins[0].name}`)! } : { part }); }
      return;
    }
    if (!hit) {
      const start = sceneAt(e);
      drag.current = { type: 'marquee', start, additive: e.shiftKey };
      setMarqueeEnd(start);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const labelEl = (e.target as Element).closest('[data-label]');
    if (labelEl && selection.has(hit)) {
      drag.current = { type: 'label', start: p, id: hit, which: labelEl.getAttribute('data-label') as 'ref' | 'value' };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    let ids: Set<string>;
    if (e.shiftKey) { ids = new Set(selection); if (ids.has(hit)) ids.delete(hit); else ids.add(hit); }
    else ids = selection.has(hit) ? selection : new Set([hit]);
    props.onSelect([...ids]);
    if (ids.has(hit)) { drag.current = { type: 'move', start: p, ids }; e.currentTarget.setPointerCapture(e.pointerId); }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = gridAt(e);
    if (!cursor || cursor.x !== p.x || cursor.y !== p.y) { setCursor(p); props.onCursor(p); }
    const d = drag.current;
    if (!d) return;
    if (d.type === 'pan') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) > 3) { d.moved = true; setPanning(true); }
      if (d.moved) setView((v) => ({ ...v, panX: d.panX + dx, panY: d.panY + dy }));
    } else if (d.type === 'marquee') {
      setMarqueeEnd(sceneAt(e));
    } else if (delta.x !== p.x - d.start.x || delta.y !== p.y - d.start.y) setDelta({ x: p.x - d.start.x, y: p.y - d.start.y });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setPanning(false);
    if (d?.type === 'marquee') {
      const end = sceneAt(e);
      setMarqueeEnd(null);
      if (Math.hypot(end.x - d.start.x, end.y - d.start.y) * view.zoom < 4) {
        // A plain click on empty sheet: clear the selection.
        if (!d.additive) props.onSelect([]);
        return;
      }
      const hits: string[] = [];
      for (const part of sch.parts) {
        const b = partBox(part);
        if (marqueeHits(d.start, end, b.x0 * G, b.y0 * G, b.x1 * G, b.y1 * G)) hits.push(part.id);
      }
      for (const w of sch.wires) {
        if (marqueeHits(d.start, end, Math.min(w.x1, w.x2) * G, Math.min(w.y1, w.y2) * G, Math.max(w.x1, w.x2) * G, Math.max(w.y1, w.y2) * G)) hits.push(w.id);
      }
      props.onSelect(d.additive ? [...new Set([...selection, ...hits])] : hits);
      return;
    }
    if (d?.type === 'label') {
      if (delta.x || delta.y) props.onCommit(withLabelOffset(sch, d.id, d.which, delta));
      setDelta({ x: 0, y: 0 });
      return;
    }
    if (d?.type === 'move') {
      if (delta.x || delta.y) props.onCommit(moveItems(sch, d.ids, delta.x, delta.y));
      setDelta({ x: 0, y: 0 });
    }
  };

  const moving = drag.current?.type === 'move' && (delta.x || delta.y) ? drag.current.ids : null;
  const labelDrag = drag.current?.type === 'label' && (delta.x || delta.y) ? drag.current : null;
  const shown = useMemo(
    () => (moving ? moveItems(sch, moving, delta.x, delta.y) : labelDrag ? withLabelOffset(sch, labelDrag.id, labelDrag.which, delta) : sch),
    [sch, moving, labelDrag, delta]);

  // Pins with nothing on them get KiCad's small open circle.
  const openPins = useMemo(() => {
    const out = new Map<string, Point[]>();
    for (const part of sch.parts) {
      if (!symbolFor(part).card) continue;
      const open = pinPositions(part).filter((pin) =>
        !sch.wires.some((w) => onWire(w, pin.x, pin.y)) &&
        !sch.parts.some((o) => o.id !== part.id && pinPositions(o).some((q) => q.x === pin.x && q.y === pin.y)));
      if (open.length) out.set(part.id, open);
    }
    return out;
  }, [sch]);

  const opTags = useMemo(() => {
    if (!props.opValues) return [];
    const seen = new Set<string>();
    const tags: { x: number; y: number; anchor: 'end' | 'middle'; text: string }[] = [];
    for (const w of sch.wires) {
      const node = compiled.wireNode.get(w.id);
      if (!node || node === '0' || seen.has(node) || !props.opValues.has(node)) continue;
      seen.add(node);
      // Left of a vertical wire, above a horizontal one: clear of net labels, which sit up and to the right.
      const vertical = w.x1 === w.x2;
      tags.push({ x: ((w.x1 + w.x2) / 2) * G - (vertical ? 5 : 0), y: ((w.y1 + w.y2) / 2) * G + (vertical ? 3 : -5), anchor: vertical ? 'end' : 'middle', text: formatSI(props.opValues.get(node)!, 'V') });
    }
    return tags;
  }, [props.opValues, sch.wires, compiled]);

  const step = G * view.zoom;
  const ghost: Part | null = tool === 'place' && placing && cursor
    ? { id: 'ghost', kind: placing.kind, ref: '', x: cursor.x, y: cursor.y, rot: placing.rot, mirror: placing.mirror, value: placing.value ?? '', ports: placing.ports }
    : null;

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className={`canvas tool-${tool}${panning ? ' is-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setCursor(null); props.onCursor(null); }}
        onDoubleClick={(e) => {
          // The first click captured the pointer, so e.target is the canvas: find the part by position.
          if (tool !== 'select') return;
          const sc = sceneAt(e), px = sc.x / G, py = sc.y / G;
          const part = sch.parts.find((x) => { if (x.kind !== 'SUBCKT') return false; const b = partBox(x); return px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1; });
          if (part?.value.trim()) props.onOpenSubckt?.(part.value.trim());
        }}
        onContextMenu={(e) => { e.preventDefault(); if (draft) setDraft(null); else props.onCancel(); }}
      >
        <defs>
          <pattern id="sheet-grid" width={step} height={step} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.panX - 0.75} ${view.panY - 0.75})`}>
            <rect className="sheet-dot" width={1.5} height={1.5} />
          </pattern>
        </defs>
        {view.zoom >= 0.7 && <rect width="100%" height="100%" fill="url(#sheet-grid)" pointerEvents="none" />}
        <g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
          {shown.wires.map((w) => {
            const color = props.probeColors.get(compiled.wireNode.get(w.id) ?? '');
            return (
              <g key={w.id} data-id={w.id} data-kind="wire">
                {color && <line className="wire-probe" style={{ stroke: color }} x1={w.x1 * G} y1={w.y1 * G} x2={w.x2 * G} y2={w.y2 * G} />}
                <line className={`wire${selection.has(w.id) ? ' is-selected' : ''}`} x1={w.x1 * G} y1={w.y1 * G} x2={w.x2 * G} y2={w.y2 * G} />
                <line className="wire-hit" x1={w.x1 * G} y1={w.y1 * G} x2={w.x2 * G} y2={w.y2 * G} />
              </g>
            );
          })}
          {!moving && compiled.junctions.map((j) => <circle key={`${j.x},${j.y}`} className="junction" cx={j.x * G} cy={j.y * G} r={2.4} />)}
          {shown.parts.map((p) => (
            <PartView key={p.id} part={p} selected={selection.has(p.id)} error={props.errorParts.has(p.id)} open={moving ? undefined : openPins.get(p.id)} />
          ))}
          {opTags.map((t) => <text key={`${t.x},${t.y}`} className="op-tag" textAnchor={t.anchor} x={t.x} y={t.y}>{t.text}</text>)}
          {draft && cursor && route(draft, cursor).map((s, i) => (
            <line key={i} className="wire is-draft" x1={s.x1 * G} y1={s.y1 * G} x2={s.x2 * G} y2={s.y2 * G} />
          ))}
          {ghost && <PartView part={ghost} ghost />}
          {marqueeEnd && drag.current?.type === 'marquee' && (
            <rect
              className={`marquee${drag.current.start.x <= marqueeEnd.x ? '' : ' is-crossing'}`}
              x={Math.min(drag.current.start.x, marqueeEnd.x)} y={Math.min(drag.current.start.y, marqueeEnd.y)}
              width={Math.abs(marqueeEnd.x - drag.current.start.x)} height={Math.abs(marqueeEnd.y - drag.current.start.y)}
            />
          )}
        </g>
      </svg>
      <div className="canvas-hint">
        {tool === 'wire' ? (draft ? 'Click to bend · click a pin or wire to finish · Esc to stop' : 'Click to start a wire')
          : tool === 'place' ? 'Click to place · R rotate · X mirror · Esc when done'
          : tool === 'probe' ? 'Click a wire to plot its voltage · click a part to plot its current'
          : sch.parts.length === 0 ? 'Pick a part on the left, or open File > Examples' : ''}
      </div>
    </div>
  );
}
