import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { EXAMPLES } from '../core/examples';
import { compile, netName } from '../core/netlist';
import type { Part, Point, Schematic } from '../core/types';
import { emptySchematic } from '../core/types';
import { formatSI } from '../core/units';
import { SimClient, type EngineState } from '../sim/client';
import { explain, type SimResult } from '../sim/result';
import { IconDelete, IconFit, IconMirror, IconProbe, IconRedo, IconRotate, IconRun, IconSelect, IconStop, IconUndo, IconWire } from './Icons';
import { Inspector } from './Inspector';
import { MenuBar } from './Menus';
import { Palette } from './Palette';
import { QuickAdd } from './QuickAdd';
import { SchematicCanvas, type Placing, type ProbeTarget, type Tool } from './SchematicCanvas';
import { copyItems, deleteItems, docReducer, loadSaved, parseSchematic, pasteItems, patchParts, removeWireSpan, rotated, saveLocal, type Clipboard, type Doc } from './store';
import { WaveformViewer, traceColor } from './WaveformViewer';

const ANALYSIS_NAME = { tran: 'Transient', ac: 'AC sweep', dc: 'DC sweep', op: 'Operating point' } as const;
const ENGINE_NAME: Record<EngineState, string> = { idle: 'ngspice: not loaded', loading: 'ngspice: loading…', ready: 'ngspice: ready', running: 'ngspice: running…' };

const initDoc = (): Doc => ({ sch: loadSaved() ?? EXAMPLES[0].build(), past: [], future: [] });

/** Names ngspice may have saved a part's current under, most specific first. */
function currentNames(part: Part): string[] {
  const ref = part.ref.toLowerCase();
  switch (part.kind) {
    case 'V': return [`i(${ref})`];
    case 'OPAMP': return [`i(e_${ref})`];
    case 'D': return [`i(@${ref}[id])`];
    case 'NPN': case 'PNP': return [`i(@${ref}[ic])`];
    case 'NMOS': case 'PMOS': return [`i(@${ref}[id])`];
    default: return [`i(@${ref}[i])`, `i(@${ref}[c])`];
  }
}

export function App() {
  const [doc, dispatch] = useReducer(docReducer, undefined, initDoc);
  const sch = doc.sch;
  const compiled = useMemo(() => compile(sch), [sch]);
  const [selected, setSelected] = useState<string[]>([]);
  const selection = useMemo(() => new Set(selected), [selected]);
  const [tool, setTool] = useState<Tool>('select');
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);
  const [traces, setTraces] = useState<string[]>([]);
  const [engine, setEngine] = useState<EngineState>('idle');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: 'Ready' });
  const [tab, setTab] = useState<'wave' | 'netlist' | 'log'>('wave');
  const [dockH, setDockH] = useState(280);
  const [fitToken, setFitToken] = useState(0);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [zoom, setZoom] = useState(2);
  const [client] = useState(() => new SimClient(setEngine));
  const fileInput = useRef<HTMLInputElement>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [waveOpen, setWaveOpen] = useState(true);
  const clipboard = useRef<{ clip: Clipboard; pastes: number } | null>(null);

  useEffect(() => saveLocal(sch), [sch]);
  // Fetch the engine shortly after first paint so the first Run does not wait for 20 MB.
  useEffect(() => { const t = setTimeout(() => void client.warm(), 600); return () => clearTimeout(t); }, [client]);

  const commit = useCallback((next: Schematic) => dispatch({ type: 'commit', sch: next }), []);
  const say = (text: string, error = false) => setStatus({ text, error });

  const load = (next: Schematic, note: string) => {
    dispatch({ type: 'load', sch: next });
    setSelected([]); setResult(null); setTraces([]); setTool('select'); setPlacing(null);
    setFitToken((t) => t + 1);
    say(note);
  };

  const run = useCallback(async () => {
    if (busy) return;
    if (!compiled.ok) { say(compiled.issues.find((i) => i.level === 'error')!.message, true); return; }
    setBusy(true);
    say(client.state === 'ready' ? 'Simulating…' : 'Loading ngspice (about 20 MB, first run only)…');
    try {
      const r = await client.run(compiled.netlist, sch.analysis.kind);
      setResult(r); setTab('wave'); setWaveOpen(true);
      if (!r.ok) { say(explain(r.messages[0]) ?? r.messages[0], true); return; }
      setTraces((old) => {
        const keep = old.filter((name) => r.vectors.some((v) => v.name === name));
        if (keep.length) return keep;
        const labelled = [...new Set(sch.parts.filter((p) => p.kind === 'LABEL').map((p) => `v(${netName(p.value)})`))].filter((name) => r.vectors.some((v) => v.name === name));
        return (labelled.length ? labelled : r.vectors.filter((v) => v.unit === 'V').map((v) => v.name)).slice(0, 4);
      });
      const summary = `${ANALYSIS_NAME[r.kind]}: ${r.points.toLocaleString()} point${r.points === 1 ? '' : 's'} in ${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms`;
      // ngspice often limps through a broken circuit; do not let a plot hide that.
      if (r.messages.length) say(`${summary}, with warnings. ${explain(r.messages[0]) ?? r.messages[0]}`, true);
      else say(summary);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  }, [busy, client, compiled, sch]);

  const stop = () => client.cancel();
  const showWave = () => { setWaveOpen(true); setTab('wave'); };
  const closeWave = () => { setWaveOpen(false); setTab((t) => (t === 'wave' ? 'netlist' : t)); };

  const toggleTrace = (name: string) => setTraces((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));
  const onProbe = (target: ProbeTarget) => {
    if (!result?.ok) { say('Run the simulation first, then probe.', true); return; }
    if (result.kind === 'op') { say('An operating point has nothing to plot: read the values in the table below.'); return; }
    if ('node' in target) {
      if (target.node === '0') { say('That net is ground: 0 V by definition.'); return; }
      const name = `v(${target.node})`;
      if (!result.vectors.some((v) => v.name === name)) { say(`No data for net "${target.node}". Run again: the schematic changed since the last run.`, true); return; }
      toggleTrace(name); showWave();
      return;
    }
    const name = currentNames(target.part).find((n) => result.vectors.some((v) => v.name === n));
    if (!name) { say(result.kind === 'ac' ? 'AC analysis saves node voltages only; probe a wire instead.' : `No current was saved for ${target.part.ref}. Run again.`, true); return; }
    toggleTrace(name); showWave();
  };

  const pick = (kind: Part['kind']) => { setPlacing({ kind, rot: 0, mirror: false }); setTool('place'); setSelected([]); };
  const cancelTool = () => { setTool('select'); setPlacing(null); };
  const rotate = () => {
    if (tool === 'place' && placing) setPlacing({ ...placing, rot: rotated(placing.rot) });
    else if (selected.length) commit(patchParts(sch, selection, (p) => ({ rot: rotated(p.rot) })));
  };
  const mirror = () => {
    if (tool === 'place' && placing) setPlacing({ ...placing, mirror: !placing.mirror });
    else if (selected.length) commit(patchParts(sch, selection, (p) => ({ mirror: !p.mirror })));
  };
  const del = () => { if (selected.length) { commit(deleteItems(sch, selection)); setSelected([]); } };

  const copy = () => {
    if (!selected.length) return false;
    clipboard.current = { clip: copyItems(sch, selection), pastes: 0 };
    say(`Copied ${selected.length} item${selected.length === 1 ? '' : 's'}`);
    return true;
  };
  const cut = () => { if (copy()) del(); };
  const paste = () => {
    const c = clipboard.current;
    if (!c) { say('Nothing to paste: copy something first.'); return; }
    c.pastes += 1;
    const out = pasteItems(sch, c.clip, 2 * c.pastes, 2 * c.pastes);
    commit(out.sch); setSelected(out.ids); setTool('select'); setPlacing(null);
  };
  const duplicate = () => {
    if (!selected.length) return;
    const out = pasteItems(sch, copyItems(sch, selection), 2, 2);
    commit(out.sch); setSelected(out.ids);
  };
  const delSegment = () => {
    if (!cursor) return;
    const next = removeWireSpan(sch, selection, cursor);
    if (next === sch) { say('Hover over a selected wire to delete just that segment.'); return; }
    commit(next); setSelected([]);
    say('Deleted wire segment');
  };

  const save = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(sch, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${sch.title.trim().replace(/[^\w.-]+/g, '-') || 'schematic'}.fspice.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const open = async (file: File | undefined) => {
    if (!file) return;
    try { load(parseSchematic(await file.text()), `Opened ${file.name}`); } catch (err) { say(err instanceof Error ? err.message : String(err), true); }
  };

  // Keyboard. One listener, re-bound each render so it always sees current state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); }
      else if (mod && key === 'y') { e.preventDefault(); dispatch({ type: 'redo' }); }
      else if (mod && key === 's') { e.preventDefault(); save(); }
      else if (e.key === 'F5' || (mod && e.key === 'Enter')) { e.preventDefault(); void run(); }
      else if (mod && key === 'c') { if (copy()) e.preventDefault(); }
      else if (mod && key === 'x') { e.preventDefault(); cut(); }
      else if (mod && key === 'v') { e.preventDefault(); paste(); }
      else if (mod && key === 'd') { e.preventDefault(); duplicate(); }
      else if (mod || e.altKey) return;
      else if (e.key === 'Escape') cancelTool();
      else if (key === 'a') { e.preventDefault(); setQuickAdd(true); }
      else if (e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); delSegment(); }
      else if (key === 'w') { setTool('wire'); setPlacing(null); }
      else if (key === 'p') { setTool('probe'); setPlacing(null); }
      else if (key === 'r') rotate();
      else if (key === 'x') mirror();
      else if (key === 'f' || e.key === 'Home') setFitToken((t) => t + 1);
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const probeColors = useMemo(() => {
    const m = new Map<string, string>();
    if (!result?.ok || result.kind === 'op') return m;
    traces.forEach((name, i) => { const v = /^v\((.+)\)$/.exec(name); if (v) m.set(v[1], traceColor(i)); });
    return m;
  }, [traces, result]);
  const opValues = useMemo(() => {
    if (!result?.ok || result.kind !== 'op') return null;
    const m = new Map<string, number>([['0', 0]]);
    for (const v of result.vectors) { const n = /^v\((.+)\)$/.exec(v.name); if (n) m.set(n[1], v.re[0]); }
    return m;
  }, [result]);
  const errorParts = useMemo(() => new Set(compiled.issues.filter((i) => i.level === 'error' && i.partId).map((i) => i.partId!)), [compiled]);

  const dragDock = (e: React.PointerEvent<HTMLDivElement>) => {
    const startY = e.clientY, startH = dockH;
    const move = (ev: PointerEvent) => setDockH(Math.max(120, Math.min(window.innerHeight * 0.7, startH + startY - ev.clientY)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const available = result?.ok && result.kind !== 'op' ? result.vectors.filter((v) => !traces.includes(v.name)) : [];

  return (
    <div className="fulgur">
      <div className="menubar">
        <span className="brand">fulgurspice</span>
        <MenuBar menus={[
          { title: 'File', items: [
            { label: 'New', run: () => load(emptySchematic(), 'New schematic') },
            { label: 'Open…', run: () => fileInput.current?.click() },
            { label: 'Save', shortcut: 'Ctrl+S', run: save },
            { separator: true },
            { heading: 'Examples' },
            ...EXAMPLES.map((ex) => ({ label: ex.name, run: () => load(ex.build(), `Loaded example: ${ex.name}`) })),
          ] },
          { title: 'Edit', items: [
            { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !doc.past.length, run: () => dispatch({ type: 'undo' }) },
            { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !doc.future.length, run: () => dispatch({ type: 'redo' }) },
            { separator: true },
            { label: 'Copy', shortcut: 'Ctrl+C', disabled: !selected.length, run: () => void copy() },
            { label: 'Cut', shortcut: 'Ctrl+X', disabled: !selected.length, run: cut },
            { label: 'Paste', shortcut: 'Ctrl+V', run: paste },
            { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !selected.length, run: duplicate },
            { separator: true },
            { label: 'Rotate', shortcut: 'R', disabled: !selected.length && tool !== 'place', run: rotate },
            { label: 'Mirror', shortcut: 'X', disabled: !selected.length && tool !== 'place', run: mirror },
            { label: 'Delete', shortcut: 'Del', disabled: !selected.length, run: del },
            { label: 'Delete wire segment', shortcut: 'Shift+Del', disabled: !selected.length, run: delSegment },
          ] },
          { title: 'Place', items: [
            { label: 'Add part…', shortcut: 'A', run: () => setQuickAdd(true) },
            { label: 'Wire', shortcut: 'W', run: () => { setTool('wire'); setPlacing(null); } },
            { label: 'Ground', run: () => pick('GND') },
            { label: 'Net label', run: () => pick('LABEL') },
          ] },
          { title: 'Simulate', items: [
            { label: 'Run', shortcut: 'F5', disabled: busy, run: () => void run() },
            { label: 'Stop', disabled: !busy, run: stop },
            { separator: true },
            { label: 'Probe', shortcut: 'P', run: () => { setTool('probe'); setPlacing(null); } },
            { label: 'Show netlist', run: () => setTab('netlist') },
          ] },
          { title: 'View', items: [
            { label: 'Zoom to fit', shortcut: 'F', run: () => setFitToken((t) => t + 1) },
            { label: 'Show waveform', disabled: waveOpen && tab === 'wave', run: showWave },
          ] },
        ]} />
        <span className="model-name">{sch.title}</span>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { void open(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      <div className="toolbar" role="toolbar" aria-label="Tools">
        <button type="button" className="run-btn" title="Run simulation (F5)" aria-label="Run simulation" disabled={busy} onClick={() => void run()}><IconRun /></button>
        <button type="button" className="tb" title="Stop" aria-label="Stop" disabled={!busy} onClick={stop}><IconStop /></button>
        <span className="tb-sep" />
        <button type="button" className="tb" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!doc.past.length} onClick={() => dispatch({ type: 'undo' })}><IconUndo /></button>
        <button type="button" className="tb" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!doc.future.length} onClick={() => dispatch({ type: 'redo' })}><IconRedo /></button>
        <span className="tb-sep" />
        <button type="button" className="tb" title="Select (Esc)" aria-label="Select" aria-pressed={tool === 'select'} onClick={cancelTool}><IconSelect /></button>
        <button type="button" className="tb" title="Wire (W)" aria-label="Wire" aria-pressed={tool === 'wire'} onClick={() => { setTool('wire'); setPlacing(null); }}><IconWire /></button>
        <button type="button" className="tb" title="Probe (P)" aria-label="Probe" aria-pressed={tool === 'probe'} onClick={() => { setTool('probe'); setPlacing(null); }}><IconProbe /></button>
        <span className="tb-sep" />
        <button type="button" className="tb" title="Rotate (R)" aria-label="Rotate" disabled={!selected.length && tool !== 'place'} onClick={rotate}><IconRotate /></button>
        <button type="button" className="tb" title="Mirror (X)" aria-label="Mirror" disabled={!selected.length && tool !== 'place'} onClick={mirror}><IconMirror /></button>
        <button type="button" className="tb" title="Delete (Del)" aria-label="Delete" disabled={!selected.length} onClick={del}><IconDelete /></button>
        <span className="tb-sep" />
        <button type="button" className="tb" title="Zoom to fit (F)" aria-label="Zoom to fit" onClick={() => setFitToken((t) => t + 1)}><IconFit /></button>
        <span className="tb-note mono">{compiled.netlist.split('\n').find((l) => /^\.(tran|ac|dc|op)\b/.test(l))}</span>
      </div>

      <div className="workspace">
        <Palette active={tool === 'place' ? placing?.kind ?? null : null} onPick={pick} />
        <SchematicCanvas
          sch={sch} compiled={compiled} selection={selection} tool={tool} placing={placing}
          probeColors={probeColors} opValues={opValues} errorParts={errorParts} fitToken={fitToken}
          onCommit={commit} onSelect={setSelected} onProbe={onProbe} onCancel={cancelTool} onCursor={setCursor} onZoom={setZoom}
        />
        <Inspector sch={sch} compiled={compiled} selection={selection} onCommit={commit} onSelect={setSelected} onRotate={rotate} onMirror={mirror} onDelete={del} />
      </div>

      <div className="dock" style={{ height: dockH }}>
        <div className="dock-grip" onPointerDown={dragDock} />
        <div className="dock-titlerow">
          <div className="dock-tabs" role="tablist">
            {(['wave', 'netlist', 'log'] as const).filter((t) => t !== 'wave' || waveOpen).map((t) => (
              <span key={t} className={`dock-tab${tab === t ? ' is-active' : ''}`}>
                <button type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === 'wave' ? 'Waveform' : t === 'netlist' ? 'Netlist' : 'ngspice log'}
                </button>
                {t === 'wave' && <button type="button" className="dock-tab-close" aria-label="Close waveform tab" title="Close waveform tab" onClick={closeWave}>×</button>}
              </span>
            ))}
          </div>
          {tab === 'wave' && result?.ok && result.kind !== 'op' && (
            <>
              {traces.map((name, i) => (
                <span key={name} className="trace-chip" style={{ color: traceColor(i) }}>
                  {result.vectors.find((v) => v.name === name)?.label ?? name}
                  <button type="button" aria-label={`Remove ${name}`} onClick={() => toggleTrace(name)}>×</button>
                </span>
              ))}
              <select value="" aria-label="Add trace" onChange={(e) => { if (e.target.value) toggleTrace(e.target.value); }}>
                <option value="">Add trace…</option>
                {available.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
              </select>
              <span className="dock-note">drag to zoom · double-click to reset</span>
            </>
          )}
        </div>
        <div className="dock-body">
          {tab === 'netlist' && <pre className="dock-text">{compiled.netlist}</pre>}
          {tab === 'log' && <pre className="dock-text">{result?.log.trim() || 'No run yet.'}</pre>}
          {tab === 'wave' && (!result ? (
            <div className="plot"><div className="plot-empty">Press Run (F5) to simulate.</div></div>
          ) : !result.ok ? (
            <div className="dock-pane sim-error">
              <strong>ngspice could not simulate this circuit.</strong>
              <ul>{result.messages.map((m, i) => <li key={i}><span className="mono">{m}</span>{explain(m) && <span className="why">{explain(m)}</span>}</li>)}</ul>
            </div>
          ) : result.kind === 'op' ? (
            <div className="dock-pane">
              <table className="op-table">
                <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
                <tbody>{result.vectors.map((v) => <tr key={v.name}><td>{v.label}</td><td className="num">{formatSI(v.re[0], v.unit, 6)}</td></tr>)}</tbody>
              </table>
            </div>
          ) : (
            <WaveformViewer result={result} traces={traces} />
          ))}
        </div>
      </div>

      {quickAdd && <QuickAdd onClose={() => setQuickAdd(false)} onPick={(kind) => { setQuickAdd(false); pick(kind); }} />}

      <div className="statusbar">
        <span className={`status-main${status.error ? ' is-error' : ''}`} role="status">{status.text}</span>
        <span className="status-cell mono">{cursor ? `x ${cursor.x}  y ${cursor.y}` : 'x –  y –'}</span>
        <span className="status-cell mono">{Math.round(zoom * 50)}%</span>
        <span className="status-cell">{sch.parts.filter((p) => p.ref).length} parts · {compiled.nodes.length} nets</span>
        <span className="status-cell status-engine">{ENGINE_NAME[engine]}</span>
      </div>
    </div>
  );
}
