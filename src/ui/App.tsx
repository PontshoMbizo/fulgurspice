import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { EXAMPLES } from '../core/examples';
import { compile, netName } from '../core/netlist';
import type { Part, Point, Schematic } from '../core/types';
import { emptySchematic } from '../core/types';
import { formatSI } from '../core/units';
import { SimClient, type EngineState } from '../sim/client';
import { currentNames, explain, type SimResult } from '../sim/result';
import {
  IconActivity, IconChevronDown, IconCircleAlert, IconCircleCheck, IconCircuitBoard, IconDelete, IconFileText, IconFit, IconMaximize2, IconMinimize2, IconMinus,
  IconMirror, IconPanelLeft, IconPanelRight, IconPlus, IconProbe, IconRedo, IconRotate, IconRuler, IconRun, IconSelect, IconStop, IconTerminal, IconUndo, IconWire, IconX,
} from './Icons';
import { InlineField } from './Field';
import { Inspector } from './Inspector';
import { PartsLibrary } from './PartsLibrary';
import { MenuBar } from './Menus';
import { QuickAdd } from './QuickAdd';
import { SchematicCanvas, type Placing, type ProbeTarget, type Tool } from './SchematicCanvas';
import { addSubckt, copyItems, deleteItems, docReducer, loadSaved, parseSchematic, pasteItems, patchParts, removeSubckt, removeWireSpan, rotated, saveLocal, sheetOf, subcktNameProblem, type Clipboard, type Doc } from './store';
import { NamePrompt } from './NamePrompt';
import { makeSubckt } from '../core/extract';
import { renameSubckt, subcktPorts } from '../core/subckt';
import { SUBCKT_NAME } from '../core/symbols';
import { WaveformViewer, traceColor } from './WaveformViewer';
import { evaluate, measurementsOf, mergeSweep, withDerived } from '../sim/analysis';
import { parseSweep } from '../core/params';
import { captureForGrading } from '../sim/capture';
import { announceReady, listenForInit, sendChange, sendResult, type InitMessage, type Mode } from './scopeio';

const ANALYSIS_NAME = { tran: 'Transient', ac: 'AC sweep', dc: 'DC sweep', op: 'Operating point' } as const;
const ENGINE_NAME: Record<EngineState, string> = { idle: 'ngspice: not loaded', loading: 'ngspice: loading…', ready: 'ngspice: ready', running: 'ngspice: running…' };

const initDoc = (): Doc => ({ sch: loadSaved() ?? EXAMPLES[0].build(), past: [], future: [] });

/** scope.io's action button for each mode; `run` = simulate first and send the grading capture. */
const ACTION: Record<Mode, { label: string; run: boolean }> = {
  export: { label: 'Save starter', run: false },
  capture: { label: 'Capture golden', run: true },
  solve: { label: 'Submit', run: true },
};

export function App() {
  const [doc, dispatch] = useReducer(docReducer, undefined, initDoc);
  const sch = doc.sch;
  const compiled = useMemo(() => compile(sch), [sch]);
  // Which subcircuit's sheet is open (null = the top sheet). Falls back to the top
  // sheet if that subcircuit disappears, e.g. through undo.
  const [edit, setEdit] = useState<string | null>(null);
  const editing = edit !== null && sch.subckts.some((s) => s.name === edit) ? edit : null;
  /** The sheet on screen, as an ordinary schematic: every edit below works on this. */
  const sheet = useMemo(() => sheetOf(sch, editing), [sch, editing]);
  const view = useMemo(() => (editing === null ? compiled : compile(sch, { sheet: editing })), [sch, editing, compiled]);
  // The name prompt serves two jobs: a new empty subcircuit, or one made from the selection.
  const [naming, setNaming] = useState<null | 'new' | 'extract'>(null);
  // A subcircuit sheet with test-bench parts can be run on its own; `resultOf` says which sheet a result is for.
  const bench = useMemo(() => (editing !== null && sheet.parts.some((p) => p.bench) ? compile(sch, { sheet: editing, standalone: true }) : null), [sch, editing, sheet]);
  const [resultOf, setResultOf] = useState<string | null>(null);
  const sweep = useMemo(() => parseSweep(sch.sweep).sweep, [sch.sweep]);
  const [selected, setSelected] = useState<string[]>([]);
  const selection = useMemo(() => new Set(selected), [selected]);
  const [tool, setTool] = useState<Tool>('select');
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);
  const [traces, setTraces] = useState<string[]>([]);
  const [engine, setEngine] = useState<EngineState>('idle');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: 'Ready' });
  const [tab, setTab] = useState<'wave' | 'meas' | 'netlist' | 'log'>('wave');
  const [stacked, setStacked] = useState(false);
  // Trace-math expressions the user has typed; they become traces named after themselves.
  const [exprs, setExprs] = useState<string[]>([]);
  const [exprText, setExprText] = useState('');
  const [dockH, setDockH] = useState(() => Math.min(240, Math.round(window.innerHeight * 0.3)));
  // The whole bottom panel (waveform, measurements, netlist, log) can be put away; a run brings it back.
  const [dockOpen, setDockOpen] = useState(true);
  const [fitToken, setFitToken] = useState(0);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [zoom, setZoom] = useState(2);
  const [client] = useState(() => new SimClient(setEngine));
  const fileInput = useRef<HTMLInputElement>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [waveOpen, setWaveOpen] = useState(true);
  const clipboard = useRef<{ clip: Clipboard; pastes: number } | null>(null);
  // Layout only: the parts library (a drawer on a phone), the Properties overlay on narrow
  // screens, the results dock maximised over the workspace, and the zoom buttons.
  const narrow = () => window.matchMedia('(max-width: 520px)').matches;
  const [libOpen, setLibOpen] = useState(() => !narrow());
  const [propsOpen, setPropsOpen] = useState(false);
  const [dockMax, setDockMax] = useState(false);
  const [zoomReq, setZoomReq] = useState({ token: 0, factor: 1 });
  const zoomBy = (factor: number) => setZoomReq((z) => ({ token: z.token + 1, factor }));
  useEffect(() => { if (!dockOpen) setDockMax(false); }, [dockOpen]);

  // scope.io (or another host) driving us through scopeio:init. Null when standalone or plainly framed.
  const [host, setHost] = useState<InitMessage | null>(null);
  const enforceLocks = host?.mode === 'solve';
  const analysisLocked = !!host && (host.config.lockAnalysis ?? host.mode !== 'export');
  const seeded = useRef(false);
  const loadRef = useRef<(next: Schematic, note: string) => void>(() => {});
  useEffect(() => {
    const off = listenForInit((m) => {
      setHost(m);
      // The host may send init more than once (on our ready, on iframe load, and when its settings
      // change): seed only once, but keep the problem's analysis and sweep in step with the host.
      // Through the reducer, not a ref of the document: a second init can arrive before React has
      // rendered the seeded one, and patching the stale document would undo the seed.
      if (seeded.current) {
        if (m.config.analysis || m.config.sweep) dispatch({ type: 'setRun', analysis: m.config.analysis, sweep: m.config.sweep });
        return;
      }
      seeded.current = true;
      let next = emptySchematic();
      if (m.starterCode.trim()) {
        try { next = parseSchematic(m.starterCode); } catch (err) { setStatus({ text: `The problem's schematic could not be read: ${err instanceof Error ? err.message : String(err)}`, error: true }); }
      }
      if (m.config.analysis) next = { ...next, analysis: m.config.analysis };
      if (m.config.sweep) next = { ...next, sweep: m.config.sweep };
      loadRef.current(next, m.mode === 'solve' ? 'Problem loaded. Press Submit when your circuit is ready.' : 'Problem schematic loaded');
    });
    announceReady();
    return off;
  }, []);

  // Standalone: autosave in this browser. Under a host: the host keeps the draft.
  useEffect(() => { if (host) sendChange(JSON.stringify(sch)); else saveLocal(sch); }, [sch, host]);
  // Fetch the engine shortly after first paint so the first Run does not wait for 20 MB.
  useEffect(() => { const t = setTimeout(() => void client.warm(), 600); return () => clearTimeout(t); }, [client]);

  /** `onSheet` is the sheet `next` belongs to: the open one unless told otherwise (null = top sheet). */
  const commit = useCallback((next: Schematic, onSheet: string | null = editing) => dispatch({ type: 'commit', sch: next, sheet: onSheet }), [editing]);
  const say = (text: string, error = false) => setStatus({ text, error });

  const load = (next: Schematic, note: string) => {
    dispatch({ type: 'load', sch: next });
    setEdit(null); setSelected([]); setResult(null); setResultOf(null); setTraces([]); setExprs([]); setTool('select'); setPlacing(null);
    setFitToken((t) => t + 1);
    say(note);
  };
  loadRef.current = load;

  const run = useCallback(async (whole = false): Promise<SimResult | null> => {
    if (busy) return null;
    // On a subcircuit sheet with a test bench, Run simulates that sheet on its own.
    const alone = !whole && bench !== null && editing !== null;
    const target = alone ? bench : compiled;
    if (!target.ok) { say(target.issues.find((i) => i.level === 'error')!.message, true); return null; }
    setBusy(true);
    say(client.state === 'ready' ? 'Simulating…' : 'Loading ngspice (about 20 MB, first run only)…');
    try {
      let r: SimResult;
      if (sweep && sch.analysis.kind !== 'op') {
        // ngspice has no .step: run once per value and merge the runs into one plot
        const runs: SimResult[] = [];
        let failed: SimResult | null = null;
        for (const [i, v] of sweep.values.entries()) {
          say(`Sweep ${i + 1} of ${sweep.values.length}: ${sweep.param} = ${v.tag}…`);
          const c = alone ? compile(sch, { sheet: editing!, standalone: true, sweepValue: v.value }) : compile(sch, { sweepValue: v.value });
          const one = await client.run(c.netlist, sch.analysis.kind);
          if (!one.ok) { failed = { ...one, messages: one.messages.map((m) => `${sweep.param} = ${v.tag}: ${m}`) }; break; }
          runs.push(one);
        }
        r = failed ?? mergeSweep(sweep.param, sweep.values.map((v) => v.tag), runs);
      } else r = await client.run(target.netlist, sch.analysis.kind);
      setResult(r); setResultOf(alone ? editing : null); setTab('wave'); setWaveOpen(true); setDockOpen(true);
      if (!r.ok) { say(explain(r.messages[0]) ?? r.messages[0], true); return r; }
      const goodExprs = exprs.filter((e) => evaluate(e, r).ok);
      setExprs(goodExprs);
      setTraces((old) => {
        const keep = old.filter((name) => r.vectors.some((v) => v.name === name) || goodExprs.includes(name));
        if (keep.length) return keep;
        const labelled = [...new Set((alone ? sheet : sch).parts.filter((p) => p.kind === 'LABEL' || p.kind === 'PORT').map((p) => `v(${netName(p.value)})`))].filter((name) => r.vectors.some((v) => v.name === name));
        return (labelled.length ? labelled : r.vectors.filter((v) => v.unit === 'V').map((v) => v.name)).slice(0, 4);
      });
      const summary = `${alone ? `${editing} on its own — ` : ''}${r.sweep ? `${r.sweep.runs.length} runs of ` : ''}${ANALYSIS_NAME[r.kind]}: ${r.points.toLocaleString()} point${r.points === 1 ? '' : 's'} in ${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms`;
      // ngspice often limps through a broken circuit; do not let a plot hide that.
      if (r.messages.length) say(`${summary}, with warnings. ${explain(r.messages[0]) ?? r.messages[0]}`, true);
      else say(summary);
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      say(explain(msg) ? `${msg}. ${explain(msg)}` : msg, true);
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, client, compiled, sch, sheet, bench, editing, exprs, sweep]);

  const stop = () => client.cancel();

  /** scope.io's button: save the starter, or run the whole circuit and send what the grader needs. */
  const doAction = async () => {
    if (!host) return;
    const code = JSON.stringify(sch);
    if (!ACTION[host.mode].run) { sendResult({ code, ok: true }); say('Starter sent to scope.io'); return; }
    if (!compiled.ok) {
      const msg = compiled.issues.find((i) => i.level === 'error')!.message;
      say(msg, true);
      sendResult({ code, ok: false, netlist: compiled.netlist, log: msg });
      return;
    }
    const r = await run(true);
    if (!r) return; // stopped, or it could not start (the status bar says why)
    if (!r.ok) {
      sendResult({ code, ok: false, netlist: compiled.netlist, log: r.messages.map((m) => (explain(m) ? `${m}\n  ${explain(m)}` : m)).join('\n') || 'ngspice could not simulate this circuit' });
      return;
    }
    const c = captureForGrading(r, sch.analysis, host.config.probes ?? { output: 'out' });
    if (!c.ok) { say(c.error, true); sendResult({ code, ok: false, netlist: compiled.netlist, log: c.error }); return; }
    sendResult({ code, ok: true, netlist: compiled.netlist, capture: c.capture });
    say(host.mode === 'solve' ? 'Submitted to scope.io for grading' : 'Golden run sent to scope.io');
  };
  const showWave = () => { setWaveOpen(true); setTab('wave'); setDockOpen(true); };
  const closeWave = () => { setWaveOpen(false); setTab((t) => (t === 'wave' ? 'netlist' : t)); };

  const toggleTrace = (name: string) => setTraces((t) => (t.includes(name) ? t.filter((x) => x !== name) : [...t, name]));
  const onProbe = (target: ProbeTarget) => {
    if (!result?.ok) { say('Run the simulation first, then probe.', true); return; }
    if (resultOf !== editing) { say(editing !== null ? 'The current result is for another sheet. Add test-bench parts and Run to simulate this subcircuit on its own.' : 'The current result is for a subcircuit on its own. Run the whole circuit, then probe.', true); return; }
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

  const openSubckt = (name: string) => {
    const def = sch.subckts.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!def) { say(`There is no subcircuit called "${name}". Create it with Place > New subcircuit…`, true); return; }
    setEdit(def.name); setSelected([]); setTool('select'); setPlacing(null); setFitToken((t) => t + 1);
    say(`Editing subcircuit ${def.name}`);
  };
  const closeSubckt = () => { setEdit(null); setSelected([]); setTool('select'); setPlacing(null); setFitToken((t) => t + 1); say('Back on the top sheet'); };
  const createSubckt = (name: string) => {
    commit(addSubckt(sch, name), null);
    setNaming(null); setEdit(name); setSelected([]); setTool('select'); setPlacing(null); setFitToken((t) => t + 1);
    say(`New subcircuit ${name}: draw its inside and add Subcircuit port parts for its pins`);
  };
  const pickSubckt = (name: string) => {
    const def = sch.subckts.find((s) => s.name === name);
    if (!def) return;
    if (editing === name) { say(`${name} cannot be placed inside its own sheet`, true); return; }
    setPlacing({ kind: 'SUBCKT', rot: 0, mirror: false, value: def.name, ports: subcktPorts(def) }); setTool('place'); setSelected([]);
  };
  const deleteSubckt = (name: string) => {
    const uses = [{ parts: sch.parts }, ...sch.subckts].reduce((n, sh) => n + sh.parts.filter((p) => p.kind === 'SUBCKT' && p.value.trim().toLowerCase() === name.toLowerCase()).length, 0);
    commit(removeSubckt(sch, name), null);
    say(uses ? `Deleted subcircuit ${name}. ${uses} instance${uses === 1 ? '' : 's'} of it now ${uses === 1 ? 'has' : 'have'} no definition (Undo brings it back)` : `Deleted subcircuit ${name}`, uses > 0);
  };

  const onRoot = (patch: Partial<Schematic>) => commit({ ...sch, ...patch }, null);
  const renameOpen = (to: string) => {
    if (editing === null) return;
    const name = to.trim();
    if (name === editing) return;
    const caseOnly = name.toLowerCase() === editing.toLowerCase();
    const problem = caseOnly ? (SUBCKT_NAME.test(name) ? null : 'Use letters, digits and underscores, not starting with a digit') : subcktNameProblem(sch, name);
    if (problem) { say(`Cannot rename: ${problem}`, true); return; }
    commit(renameSubckt(sch, editing, name), null);
    setEdit(name);
    say(`Renamed ${editing} to ${name}; every instance follows`);
  };
  const setSubcktParams = (params: string) => {
    if (editing === null) return;
    commit({ ...sch, subckts: sch.subckts.map((d) => (d.name === editing ? { ...d, params: params.trim() || undefined } : d)) }, null);
  };
  // Check the selection before asking for a name, so a bad one fails at once with the reason.
  const askMakeSubckt = () => {
    if (enforceLocks && sheet.parts.some((p) => selection.has(p.id) && p.locked)) { say('The selection has locked parts, which must stay where the problem put them', true); return; }
    const dry = makeSubckt(sch, editing, selection, 'TMP_CHECK');
    if (!dry.ok) { say(dry.error, true); return; }
    setNaming('extract');
  };
  const makeFromSelection = (name: string) => {
    const made = makeSubckt(sch, editing, selection, name);
    setNaming(null);
    if (!made.ok) { say(made.error, true); return; }
    commit(made.sch, null);
    setSelected([made.instanceId]); setTool('select'); setPlacing(null);
    say(`Made subcircuit ${name} (ports: ${made.ports.length ? made.ports.join(', ') : 'none: ground only'}). Double-click the new part to open it`);
  };

  const pick = (kind: Part['kind']) => { setPlacing({ kind, rot: 0, mirror: false }); setTool('place'); setSelected([]); };
  const cancelTool = () => { setTool('select'); setPlacing(null); };
  const rotate = () => {
    if (tool === 'place' && placing) setPlacing({ ...placing, rot: rotated(placing.rot) });
    else if (selected.length) commit(patchParts(sheet, selection, (p) => ({ rot: rotated(p.rot) })));
  };
  const mirror = () => {
    if (tool === 'place' && placing) setPlacing({ ...placing, mirror: !placing.mirror });
    else if (selected.length) commit(patchParts(sheet, selection, (p) => ({ mirror: !p.mirror })));
  };
  const del = () => {
    if (!selected.length) return;
    // a learner can't delete the parts the problem locked; the rest of the selection goes
    const gone = enforceLocks ? new Set([...selection].filter((id) => !sheet.parts.some((p) => p.id === id && p.locked))) : selection;
    if (gone.size < selection.size) say('Locked parts stay: the problem needs them', true);
    if (gone.size) commit(deleteItems(sheet, gone));
    setSelected([]);
  };

  const copy = () => {
    if (!selected.length) return false;
    clipboard.current = { clip: copyItems(sheet, selection), pastes: 0 };
    say(`Copied ${selected.length} item${selected.length === 1 ? '' : 's'}`);
    return true;
  };
  const cut = () => { if (copy()) del(); };
  const paste = () => {
    const c = clipboard.current;
    if (!c) { say('Nothing to paste: copy something first.'); return; }
    c.pastes += 1;
    const out = pasteItems(sheet, c.clip, 2 * c.pastes, 2 * c.pastes);
    commit(out.sch); setSelected(out.ids); setTool('select'); setPlacing(null);
  };
  const duplicate = () => {
    if (!selected.length) return;
    const out = pasteItems(sheet, copyItems(sheet, selection), 2, 2);
    commit(out.sch); setSelected(out.ids);
  };
  const delSegment = () => {
    if (!cursor) return;
    const next = removeWireSpan(sheet, selection, cursor);
    if (next === sheet) { say('Hover over a selected wire to delete just that segment.'); return; }
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
      else if (mod && key === 'j') { e.preventDefault(); setDockOpen((o) => !o); }
      else if (mod && key === 'd') { e.preventDefault(); duplicate(); }
      else if (mod || e.altKey) return;
      else if (e.key === 'Escape') { if (editing !== null && tool === 'select' && !selected.length) closeSubckt(); else cancelTool(); }
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

  // The result plus the user's trace math, as extra traces. Everything the dock shows reads from this.
  const shown = useMemo(() => (result?.ok && result.kind !== 'op' ? withDerived(result, exprs).result : result), [result, exprs]);
  const measurements = useMemo(() => (result ? measurementsOf(result) : []), [result]);
  const available = shown?.ok && shown.kind !== 'op' ? shown.vectors.filter((v) => !traces.includes(v.name)) : [];
  const addExpr = () => {
    const text = exprText.trim();
    if (!text || !result?.ok || result.kind === 'op') return;
    const r = evaluate(text, result);
    if (!r.ok) { say(r.error, true); return; }
    setExprs((old) => (old.includes(text) ? old : [...old, text]));
    setTraces((old) => (old.includes(text) ? old : [...old, text]));
    setExprText(''); say(`Added trace ${text}`);
  };

  return (
    <div className={`fulgur${libOpen ? ' lib-open' : ''}${propsOpen ? ' props-open' : ''}${dockOpen && dockMax ? ' results-max' : ''}${host?.config.theme === 'light' ? ' theme-light' : ''}`}>
      <div className="menubar">
        <span className="brand"><span className="brand-mark"><IconCircuitBoard /></span>fulgurspice</span>
        <MenuBar menus={[
          // Under scope.io the problem decides what is on the sheet: no New, Open or Examples.
          { title: 'File', items: host ? [
            { label: 'Save a copy', shortcut: 'Ctrl+S', run: save },
          ] : [
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
            { separator: true },
            { label: 'Subcircuit port', disabled: editing === null, run: () => pick('PORT') },
            { label: 'New subcircuit…', run: () => setNaming('new') },
            { label: 'Make subcircuit from selection…', disabled: !selected.length, run: askMakeSubckt },
            { label: 'Top sheet', disabled: editing === null, run: closeSubckt },
            ...(sch.subckts.length ? [{ separator: true } as const, { heading: 'Edit subcircuit' } as const, ...sch.subckts.map((d) => ({ label: d.name, run: () => openSubckt(d.name) }))] : []),
          ] },
          { title: 'Simulate', items: [
            { label: editing !== null && bench ? `Run ${editing} on its own` : 'Run', shortcut: 'F5', disabled: busy, run: () => void run() },
            { label: 'Run whole circuit', disabled: busy || editing === null || bench === null, run: () => void run(true) },
            { label: 'Stop', disabled: !busy, run: stop },
            { separator: true },
            { label: 'Probe', shortcut: 'P', run: () => { setTool('probe'); setPlacing(null); } },
            { label: 'Show netlist', run: () => { setTab('netlist'); setDockOpen(true); } },
          ] },
          { title: 'View', items: [
            { label: 'Zoom to fit', shortcut: 'F', run: () => setFitToken((t) => t + 1) },
            { label: 'Zoom in', run: () => zoomBy(1.25) },
            { label: 'Zoom out', run: () => zoomBy(0.8) },
            { separator: true },
            { label: libOpen ? 'Hide parts library' : 'Show parts library', run: () => setLibOpen((o) => !o) },
            { label: 'Bottom panel', shortcut: 'Ctrl+J', run: () => setDockOpen((o) => !o) },
            { label: dockMax ? 'Restore results' : 'Maximise results', disabled: !dockOpen, run: () => setDockMax((m) => !m) },
            { label: 'Show waveform', disabled: dockOpen && waveOpen && tab === 'wave', run: showWave },
          ] },
        ]} />
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { void open(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      <div className="toolbar" role="toolbar" aria-label="Tools">
        <button type="button" className="run-btn" title="Run simulation (F5)" aria-label="Run simulation" disabled={busy} onClick={() => void run()}><IconRun size={13} />{busy ? 'Running…' : 'Run'}</button>
        {host && <button type="button" className="run-btn action-btn" title={ACTION[host.mode].label} disabled={busy} onClick={() => void doAction()}><IconCircleCheck size={13} />{ACTION[host.mode].label}</button>}
        <button type="button" className="tb" title="Stop" aria-label="Stop" disabled={!busy} onClick={stop}><IconStop /></button>
        <span className="tb-sep" />
        <button type="button" className="tb" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!doc.past.length} onClick={() => dispatch({ type: 'undo' })}><IconUndo /></button>
        <button type="button" className="tb" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!doc.future.length} onClick={() => dispatch({ type: 'redo' })}><IconRedo /></button>
        <span className="tb-sep" />
        <button type="button" className="tb" title="Select (Esc)" aria-label="Select" aria-pressed={tool === 'select'} onClick={cancelTool}><IconSelect /></button>
        <button type="button" className="tb" title="Wire (W)" aria-label="Wire" aria-pressed={tool === 'wire'} onClick={() => { setTool('wire'); setPlacing(null); }}><IconWire /></button>
        <button type="button" className="tb" title="Probe (P)" aria-label="Probe" aria-pressed={tool === 'probe'} onClick={() => { setTool('probe'); setPlacing(null); }}><IconProbe /></button>
        <span className="tb-sep" />
        <button type="button" className="tb tb-optional" title="Rotate (R)" aria-label="Rotate" disabled={!selected.length && tool !== 'place'} onClick={rotate}><IconRotate /></button>
        <button type="button" className="tb tb-optional" title="Mirror (X)" aria-label="Mirror" disabled={!selected.length && tool !== 'place'} onClick={mirror}><IconMirror /></button>
        <button type="button" className="tb" title="Delete (Del)" aria-label="Delete" disabled={!selected.length} onClick={del}><IconDelete /></button>
        <span className="tb-sep" />
        <button type="button" className="tb" title="Parts library" aria-label="Toggle parts library" aria-pressed={libOpen} onClick={() => setLibOpen((o) => !o)}><IconPanelLeft /></button>
        <div className="run-settings">
          {sch.analysis.kind === 'tran' ? (() => {
            const a = sch.analysis;
            return <>
              <InlineField label="Stop" title="Transient stop time, seconds" value={a.stop} disabled={analysisLocked} onCommit={(v) => onRoot({ analysis: { ...a, stop: v } })} />
              <InlineField label="Step" title="Maximum time step" className="step-field" value={a.step} disabled={analysisLocked} onCommit={(v) => onRoot({ analysis: { ...a, step: v } })} />
            </>;
          })() : (
            <span className="tb-note mono">{compiled.netlist.split('\n').find((l) => /^\.(tran|ac|dc|op)\b/.test(l))}</span>
          )}
        </div>
        <button type="button" className="tb props-toggle" title="Properties" aria-label="Toggle properties" aria-pressed={propsOpen} onClick={() => setPropsOpen((o) => !o)}><IconPanelRight /><span className="control-word">Properties</span></button>
      </div>

      <div className="workspace">
        {libOpen && (
          <PartsLibrary
            active={tool === 'place' && placing ? placing.kind : null} activeSubckt={tool === 'place' && placing?.kind === 'SUBCKT' ? placing.value ?? null : null}
            subckts={sch.subckts} canPlacePort={editing !== null}
            onPick={(kind) => { pick(kind); if (narrow()) setLibOpen(false); }}
            onPickSubckt={(name) => { pickSubckt(name); if (narrow()) setLibOpen(false); }}
          />
        )}
        <div className="center">
          <div className="canvas-header">
            <nav className="breadcrumb" aria-label="Sheet path">
              <IconCircuitBoard size={13} />
              {editing !== null ? <>
                <button type="button" className="crumb-link model-name" onClick={closeSubckt} title="Back to the top sheet (Esc)">{sch.title || 'Untitled'}</button>
                <span>/</span>
                <span>subcircuit <strong>{editing}</strong></span>
              </> : <>
                <span className="model-name">{sch.title || 'Untitled'}</span>
                <span>/</span>
                <strong>Schematic</strong>
              </>}
            </nav>
            <button type="button" className="icon-btn" title="Zoom to fit (F)" aria-label="Zoom to fit" onClick={() => setFitToken((t) => t + 1)}><IconFit /></button>
          </div>
          <div className="stage">
            <SchematicCanvas
              sch={sheet} compiled={view} selection={selection} tool={tool} placing={placing}
              probeColors={resultOf === editing ? probeColors : new Map()} opValues={resultOf === editing ? opValues : null} errorParts={errorParts} fitToken={fitToken} zoomRequest={zoomReq}
              onCommit={commit} onSelect={setSelected} onProbe={onProbe} onCancel={cancelTool} onCursor={setCursor} onZoom={setZoom} onOpenSubckt={openSubckt}
            />
            <div className="zoom-pill">
              <button type="button" className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(0.8)}><IconMinus size={13} /></button>
              <span>{Math.round(zoom * 50)}%</span>
              <button type="button" className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><IconPlus size={13} /></button>
            </div>
          </div>
        </div>
        <Inspector sch={sheet} compiled={view} selection={selection} onCommit={commit} onSelect={setSelected} onRotate={rotate} onMirror={mirror} onDelete={del} editing={editing} onOpenSubckt={openSubckt} onRoot={onRoot} onRenameSubckt={renameOpen} onSubcktParams={setSubcktParams} onMakeSubckt={askMakeSubckt} onDeleteSubckt={() => { if (editing !== null) { deleteSubckt(editing); setEdit(null); } }} enforceLocks={enforceLocks} canLock={!!host && !enforceLocks} analysisLocked={analysisLocked} />
      </div>

      {dockOpen && <div className="dock" style={{ height: dockH }}>
        <div className="dock-grip" onPointerDown={dragDock} />
        <div className="dock-titlerow">
          <div className="dock-tabs" role="tablist">
            {(['wave', 'meas', 'netlist', 'log'] as const).filter((t) => (t !== 'wave' || waveOpen) && (t !== 'meas' || measurements.length > 0)).map((t) => (
              <span key={t} className={`dock-tab${tab === t ? ' is-active' : ''}`}>
                <button type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === 'wave' ? <><IconActivity size={14} />Waveforms</> : t === 'meas' ? <><IconRuler size={14} />Measurements ({measurements.length})</> : t === 'netlist' ? <><IconFileText size={14} />Netlist</> : <><IconTerminal size={14} />Log</>}
                </button>
                {t === 'wave' && <button type="button" className="dock-tab-close" aria-label="Close waveform tab" title="Close waveform tab" onClick={closeWave}><IconX size={12} /></button>}
              </span>
            ))}
          </div>
          <span className="dock-spacer" />
          <button type="button" className="icon-btn" title={dockMax ? 'Restore the workspace' : 'Maximise results'} aria-label={dockMax ? 'Restore the workspace' : 'Maximise results'} aria-pressed={dockMax} onClick={() => setDockMax((m) => !m)}>{dockMax ? <IconMinimize2 /> : <IconMaximize2 />}</button>
          <button type="button" className="icon-btn dock-hide" title="Hide the bottom panel (Ctrl+J)" aria-label="Hide the bottom panel" onClick={() => setDockOpen(false)}><IconChevronDown /></button>
        </div>
        {tab === 'wave' && shown?.ok && shown.kind !== 'op' && (
          <div className="dock-legend">
            {traces.map((name, i) => (
              <span key={name} className="trace-chip" style={{ color: traceColor(i) }}>
                {shown.vectors.find((v) => v.name === name)?.label ?? name}
                <button type="button" aria-label={`Remove ${name}`} onClick={() => toggleTrace(name)}>×</button>
              </span>
            ))}
            <select value="" aria-label="Add trace" onChange={(e) => { if (e.target.value) toggleTrace(e.target.value); }}>
              <option value="">Add trace…</option>
              {available.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
            </select>
            <input
              className="expr-input" aria-label="Trace math" value={exprText} spellCheck={false}
              placeholder="Trace math: V(out)/V(in)"
              onChange={(e) => setExprText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExpr(); } }}
            />
            <span className="dock-note">drag: zoom · wheel: y zoom · click: cursors A, B · dbl-click: reset</span>
          </div>
        )}
        <div className="dock-body">
          {tab === 'netlist' && <pre className="dock-text">{(bench ?? compiled).netlist}</pre>}
          {tab === 'meas' && (
            <div className="dock-pane">
              <table className="op-table">
                <thead><tr><th>Measurement</th><th>Value</th><th>Detail</th></tr></thead>
                <tbody>
                  {measurements.map((m) => (
                    <tr key={m.name}>
                      <td className="mono">{m.name}</td>
                      <td className={`num${m.value === null ? ' is-error' : ''}`}>{m.value === null ? 'failed' : String(Number(m.value.toPrecision(6)))}</td>
                      <td className="mono muted">{m.value === null && explain(`Error: measure ${m.name}`) ? 'the event it looks for never happens, or the syntax is wrong' : m.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">Add measurements under SPICE directives, e.g. <span className="mono">.meas tran vmax MAX v(out)</span>. ngspice evaluates them.</p>
            </div>
          )}
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
            <WaveformViewer result={shown!} traces={traces} stacked={stacked} onStacked={setStacked} fileBase={sch.title} />
          ))}
        </div>
      </div>}

      {quickAdd && <QuickAdd subckts={sch.subckts} onClose={() => setQuickAdd(false)} onPick={(kind) => { setQuickAdd(false); pick(kind); }} onPickSubckt={(name) => { setQuickAdd(false); pickSubckt(name); }} />}
      {naming && <NamePrompt title={naming === 'new' ? 'New subcircuit' : 'Make subcircuit from selection'} problem={(n) => subcktNameProblem(sch, n)} onSubmit={naming === 'new' ? createSubckt : makeFromSelection} onClose={() => setNaming(null)} />}

      <div className="statusbar">
        <span className={`status-main${status.error ? ' is-error' : ''}`}>
          {status.error ? <IconCircleAlert size={13} /> : busy ? <IconActivity size={13} /> : <IconCircleCheck size={13} />}
          <span role="status">{status.text}</span>
        </span>
        <button type="button" className="status-cell status-toggle" aria-pressed={dockOpen} title="Show or hide the bottom panel (Ctrl+J)" onClick={() => setDockOpen((o) => !o)}>{dockOpen ? 'Panel ⌄' : 'Panel ⌃'}</button>
        <span className="status-cell mono">{cursor ? `x ${cursor.x}  y ${cursor.y}` : 'x –  y –'}</span>
        <span className="status-cell">{sheet.parts.filter((p) => p.ref).length} parts · {view.nodes.length} nets</span>
        <span className="status-cell status-engine">{ENGINE_NAME[engine]}</span>
      </div>
    </div>
  );
}
