/// <reference lib="webworker" />
// ngspice lives here, off the UI thread. This file is the only importer of
// eecircuit-engine, so the 20 MB engine is its own chunk and loads on demand.

import { Simulation, type ResultType } from 'eecircuit-engine';

export type WorkerRequest = { id: number; type: 'warm' } | { id: number; type: 'run'; netlist: string };
export type WorkerReply =
  | { id: number; ok: true; raw: ResultType | null; errors: string[]; log: string; ms: number }
  | { id: number; ok: false; message: string };

let sim: Simulation | null = null;
let starting: Promise<void> | null = null;

async function engine(): Promise<Simulation> {
  if (!sim) sim = new Simulation();
  if (!starting) starting = sim.start();
  await starting;
  return sim;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const post = (reply: WorkerReply) => (self as DedicatedWorkerGlobalScope).postMessage(reply);
  try {
    const s = await engine();
    if (req.type === 'warm') { post({ id: req.id, ok: true, raw: null, errors: [], log: s.getInitInfo(), ms: 0 }); return; }
    s.setNetList(req.netlist);
    const t0 = performance.now();
    const raw = await s.runSim();
    post({ id: req.id, ok: true, raw, errors: s.getError(), log: s.getInfo(), ms: performance.now() - t0 });
  } catch (err) {
    post({ id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
