// Main-thread handle on the ngspice worker. A run that hangs (ngspice can spin on
// a circuit that will not converge) is ended by terminating the worker; the next
// run starts a fresh one.

import type { Analysis } from '../core/types';
import { normalise, type SimResult } from './result';
import type { WorkerReply, WorkerRequest } from './worker';

export type EngineState = 'idle' | 'loading' | 'ready' | 'running';

export class SimClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }>();
  private loaded = false;
  state: EngineState = 'idle';

  constructor(private onState: (s: EngineState) => void = () => {}) {}

  private setState(s: EngineState) { this.state = s; this.onState(s); }

  private send(msg: { type: 'warm' } | { type: 'run'; netlist: string }): Promise<WorkerReply> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const p = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        p?.resolve(e.data);
      };
      this.worker.onerror = (e) => this.reset(new Error(e.message || 'The simulation engine failed to load'));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, ...msg } as WorkerRequest);
    });
  }

  private reset(reason: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = false;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    this.setState('idle');
  }

  /** Start downloading and compiling the engine before the first run needs it. */
  async warm(): Promise<void> {
    if (this.loaded || this.state !== 'idle') return;
    this.setState('loading');
    try {
      await this.send({ type: 'warm' });
      this.loaded = true;
      if ((this.state as EngineState) === 'loading') this.setState('ready');
    } catch { /* reported on the next run */ }
  }

  async run(netlist: string, kind: Analysis['kind'], timeoutMs = 60000): Promise<SimResult> {
    this.setState(this.loaded ? 'running' : 'loading');
    const timer = setTimeout(() => this.reset(new Error(`Simulation stopped after ${timeoutMs / 1000} s`)), timeoutMs);
    try {
      const reply = await this.send({ type: 'run', netlist });
      this.loaded = true;
      this.setState('ready');
      if (!reply.ok) return normalise(null, kind, [reply.message], '', 0);
      return normalise(reply.raw, kind, reply.errors, reply.log, reply.ms);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stop button. */
  cancel() { if (this.pending.size) this.reset(new Error('Simulation stopped')); }
}
