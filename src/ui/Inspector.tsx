// Right-hand panel: the selected part's properties, or the simulation setup when
// nothing is selected. The rule-check list is always visible underneath.

import { useEffect, useRef, useState } from 'react';
import type { Compiled } from '../core/netlist';
import { symbolFor } from '../core/symbols';
import { subcktPorts } from '../core/subckt';
import { parseSweep } from '../core/params';
import type { Analysis, Schematic } from '../core/types';
import { patchParts } from './store';

/** Text field that commits on blur or Enter, so typing a value is one undo step. */
function Field({ label, value, hint, mono, onCommit }: { label: string; value: string; hint?: string; mono?: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const cancelled = useRef(false);
  const commit = () => { if (cancelled.current) { cancelled.current = false; return; } if (text !== value) onCommit(text); };
  return (
    <label className="param">
      <span>{label}</span>
      <input className={mono ? 'num' : undefined} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          // Enter only blurs: the blur handler commits, so one edit is exactly one undo step.
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { cancelled.current = true; setText(value); e.currentTarget.blur(); }
        }} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Directives({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="param is-wide">
      <textarea value={text} spellCheck={false} placeholder={'.model MYDIODE D(Is=1n)\n.param R=1k\n.meas tran vmax MAX v(out)'} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== value) onCommit(text); }} />
      <small>Added to the netlist as written.</small>
    </label>
  );
}

const DEFAULTS: Record<Analysis['kind'], Analysis> = {
  tran: { kind: 'tran', step: '10u', stop: '10m' },
  ac: { kind: 'ac', points: '20', fstart: '10', fstop: '1meg' },
  dc: { kind: 'dc', source: 'V1', start: '0', stop: '5', step: '0.1' },
  op: { kind: 'op' },
};

interface Props {
  sch: Schematic;
  compiled: Compiled;
  selection: Set<string>;
  onCommit: (sch: Schematic) => void;
  onSelect: (ids: string[]) => void;
  onRotate: () => void;
  onMirror: () => void;
  onDelete: () => void;
  /** Name of the subcircuit whose sheet is open, or null on the top sheet. */
  editing: string | null;
  onOpenSubckt: (name: string) => void;
  /** Change the document itself (analysis, title, directives) even while a subcircuit sheet is open. */
  onRoot: (patch: Partial<Schematic>) => void;
  /** Rename the open subcircuit / set its parameter defaults. */
  onRenameSubckt: (name: string) => void;
  onSubcktParams: (params: string) => void;
  onMakeSubckt: () => void;
  /** Delete the open subcircuit (instances of it keep their name and report it missing). */
  onDeleteSubckt: () => void;
}

export function Inspector({ sch, compiled, selection, onCommit, onSelect, onRotate, onMirror, onDelete, editing, onOpenSubckt, onRoot, onRenameSubckt, onSubcktParams, onMakeSubckt, onDeleteSubckt }: Props) {
  const parts = sch.parts.filter((p) => selection.has(p.id));
  const part = selection.size === 1 && parts.length === 1 ? parts[0] : null;
  const def = part ? symbolFor(part) : null;
  const a = sch.analysis;
  const setA = (next: Analysis) => onRoot({ analysis: next });
  const setSweep = (patch: Partial<NonNullable<Schematic['sweep']>>) => {
    const next = { param: sch.sweep?.param ?? '', values: sch.sweep?.values ?? '', ...patch };
    onRoot({ sweep: next.param || next.values ? next : undefined });
  };
  const sweepError = parseSweep(sch.sweep).error;
  const setBench = (on: boolean) => onCommit(patchParts(sch, selection, () => ({ bench: on || undefined })));
  const defParams = editing !== null ? (sch.subckts.find((d) => d.name === editing)?.params ?? '') : '';

  const analysisFieldset = (
    <fieldset className="etched">
      <legend>Analysis</legend>
      <label className="param">
        <span>Type</span>
        <select value={a.kind} onChange={(e) => setA(DEFAULTS[e.target.value as Analysis['kind']])}>
          <option value="tran">Transient</option>
          <option value="ac">AC sweep</option>
          <option value="dc">DC sweep</option>
          <option value="op">Operating point</option>
        </select>
      </label>
      {a.kind === 'tran' && <>
        <Field label="Stop time" value={a.stop} mono hint="seconds, e.g. 10m" onCommit={(v) => setA({ ...a, stop: v })} />
        <Field label="Max step" value={a.step} mono onCommit={(v) => setA({ ...a, step: v })} />
      </>}
      {a.kind === 'ac' && <>
        <Field label="Start frequency" value={a.fstart} mono onCommit={(v) => setA({ ...a, fstart: v })} />
        <Field label="Stop frequency" value={a.fstop} mono onCommit={(v) => setA({ ...a, fstop: v })} />
        <Field label="Points / decade" value={a.points} mono onCommit={(v) => setA({ ...a, points: v })} />
      </>}
      {a.kind === 'dc' && <>
        <Field label="Source" value={a.source} mono onCommit={(v) => setA({ ...a, source: v })} />
        <Field label="Start" value={a.start} mono onCommit={(v) => setA({ ...a, start: v })} />
        <Field label="Stop" value={a.stop} mono onCommit={(v) => setA({ ...a, stop: v })} />
        <Field label="Step" value={a.step} mono onCommit={(v) => setA({ ...a, step: v })} />
      </>}
      {a.kind !== 'op' && <>
        <Field label="Sweep parameter" value={sch.sweep?.param ?? ''} mono hint="A {name} used in a value, e.g. R. Empty: no sweep" onCommit={(v) => setSweep({ param: v.trim() })} />
        {(sch.sweep?.param || sch.sweep?.values) && <Field label="Sweep values" value={sch.sweep?.values ?? ''} mono hint="1k 2k 5k   ·   lin 1k 10k 4   ·   dec 100 10k 3" onCommit={(v) => setSweep({ values: v.trim() })} />}
        {sweepError && <p className="hint is-error">{sweepError}</p>}
      </>}
      {a.kind === 'op' && <p className="muted">DC voltages and currents with capacitors open and inductors shorted. Node voltages are written on the schematic.</p>}
    </fieldset>
  );

  return (
    <aside className="inspector" aria-label="Properties">
      <div className="panel-title">{part ? def!.label : selection.size ? `${selection.size} selected` : editing !== null ? `Subcircuit ${editing}` : 'Simulation'}</div>
      <div className="inspector-body">
        {part && def ? (
          <fieldset className="etched">
            <legend>Properties</legend>
            {def.prefix && <Field label="Reference" value={part.ref} mono onCommit={(v) => onCommit(patchParts(sch, selection, () => ({ ref: v.trim() })))} />}
            {def.valueLabel && <Field label={def.valueLabel} value={part.value} hint={def.valueHint} mono onCommit={(v) => onCommit(patchParts(sch, selection, () => ({ value: v })))} />}
            {part.kind === 'SUBCKT' && <Field label="Parameters" value={part.params ?? ''} mono hint="Override defaults, e.g. R=2k C=47n" onCommit={(v) => onCommit(patchParts(sch, selection, () => ({ params: v.trim() || undefined })))} />}
            {editing !== null && part.kind !== 'PORT' && (
              <label className="check" title="Drawn and simulated when this sheet is run on its own, but not part of the subcircuit">
                <input type="checkbox" checked={!!part.bench} onChange={(e) => setBench(e.target.checked)} /> Test bench only
              </label>
            )}
            {part.kind === 'SUBCKT' && (
              <div className="row-buttons">
                <button type="button" className="btn" disabled={!part.value.trim()} onClick={() => onOpenSubckt(part.value.trim())}>Open subcircuit</button>
              </div>
            )}
            <div className="row-buttons">
              <button type="button" className="btn" onClick={onRotate}>Rotate</button>
              <button type="button" className="btn" onClick={onMirror}>Mirror</button>
              <button type="button" className="btn btn-delete" onClick={onDelete}>Delete</button>
            </div>
            {(part.refOffset || part.valueOffset) && (
              <div className="row-buttons">
                <button type="button" className="btn" title="Drag the text on the sheet to move it" onClick={() => onCommit({ ...sch, parts: sch.parts.map((q) => { if (q.id !== part.id) return q; const { refOffset: _r, valueOffset: _v, ...rest } = q; return rest; }) })}>Reset label positions</button>
              </div>
            )}
          </fieldset>
        ) : selection.size ? (
          <fieldset className="etched">
            <legend>Selection</legend>
            <div className="row-buttons">
              <button type="button" className="btn" onClick={onRotate} disabled={!parts.length}>Rotate</button>
              <button type="button" className="btn" onClick={onMirror} disabled={!parts.length}>Mirror</button>
              <button type="button" className="btn btn-delete" onClick={onDelete}>Delete</button>
            </div>
            <div className="row-buttons">
              <button type="button" className="btn" disabled={!parts.length} title="Move the selection into a new subcircuit and put an instance in its place" onClick={onMakeSubckt}>Make subcircuit…</button>
              {editing !== null && parts.length > 0 && <button type="button" className="btn" onClick={() => setBench(!parts.every((q) => q.bench))}>{parts.every((q) => q.bench) ? 'Part of subcircuit' : 'Test bench only'}</button>}
            </div>
          </fieldset>
        ) : editing !== null ? (
          <>
            <fieldset className="etched">
              <legend>Subcircuit</legend>
              <Field label="Name" value={editing} mono hint="Renames every instance too" onCommit={onRenameSubckt} />
              <Field label="Parameters" value={defParams} mono hint="Defaults, e.g. R=1k C=100n. Use them in values as {R}" onCommit={onSubcktParams} />
              <div className="row-buttons"><button type="button" className="btn btn-delete" title="Remove this definition; Undo brings it back" onClick={onDeleteSubckt}>Delete subcircuit</button></div>
              <p className="hint">Ports: {subcktPorts(sch).length ? <span className="mono">{subcktPorts(sch).join(', ')}</span> : 'none yet'}. Each <em>Subcircuit port</em> part becomes a pin, in the order you place them.</p>
              <p className="hint">Mark a part <em>Test bench only</em> to drive this sheet on its own (source, load, ground): Run then simulates just this subcircuit. Use Simulate → Run whole circuit for the full design, and “Top sheet” to go back.</p>
            </fieldset>
            {analysisFieldset}
          </>
        ) : (
          <>
            {analysisFieldset}
            <fieldset className="etched">
              <legend>Schematic</legend>
              <Field label="Title" value={sch.title} onCommit={(v) => onRoot({ title: v })} />
            </fieldset>
            <fieldset className="etched">
              <legend>SPICE directives</legend>
              <Directives value={sch.directives} onCommit={(v) => onRoot({ directives: v })} />
            </fieldset>
          </>
        )}
        <fieldset className="etched">
          <legend>Checks</legend>
          {compiled.issues.length === 0 ? <p className="muted all-clear">Ready to simulate.</p> : (
            <ul className="issues">
              {compiled.issues.map((issue, i) => (
                <li key={i} className={issue.level === 'warning' ? 'is-warning' : undefined}>
                  {issue.partId ? <button type="button" onClick={() => onSelect([issue.partId!])}>{issue.message}</button> : issue.message}
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </div>
    </aside>
  );
}
