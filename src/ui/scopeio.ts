// postMessage bridge to scope.io, the same protocol its other embedded simulators speak
// (fpgasim, mcusim, fulgurlab):
//   host -> sim  { type: 'scopeio:init', protocol: 2, mode, starterCode, config }
//   sim  -> host { type: 'scopeio:ready' }               once the listener is registered
//                { type: 'scopeio:change', code }        debounced, so the host can keep a draft
//                { type: 'scopeio:result', payload }     when the host's action button is pressed
// mode: 'export' (author the starter: "Save starter"), 'capture' (run the reference: "Capture golden"),
// 'solve' (a learner: "Submit"). starterCode is the schematic as JSON text. config:
//   probes        { output, input? }  net labels to grade (default output "out")
//   analysis      Analysis            replaces the schematic's analysis (the problem's time grid)
//   sweep         { param, values }   a load-sweep problem: one run per value, e.g. RLOAD
//   lockAnalysis  boolean             analysis and sweep read-only (default: on except in export)
//   theme         'auto' | 'light'
// Only the empty ready message goes to '*'; everything else goes to the origin that sent init.

import type { Analysis, SweepSpec } from '../core/types';
import type { GradingCapture, Probes } from '../sim/capture';

export type Mode = 'export' | 'capture' | 'solve';

export interface HostConfig {
  probes?: Probes;
  analysis?: Analysis;
  sweep?: SweepSpec;
  lockAnalysis?: boolean;
  theme?: 'auto' | 'light';
}

export interface InitMessage { mode: Mode; starterCode: string; config: HostConfig }

export interface ResultPayload {
  /** The schematic as JSON text. */
  code: string;
  ok: boolean;
  /** The SPICE netlist the run used. */
  netlist?: string;
  /** Why it failed, for the host to show. */
  log?: string;
  capture?: GradingCapture;
}

let hostOrigin: string | null = null;
const MODES: Mode[] = ['export', 'capture', 'solve'];

export const framed = () => typeof window !== 'undefined' && window.parent !== window;

export function announceReady() {
  if (framed()) window.parent.postMessage({ type: 'scopeio:ready' }, '*');
}

export function listenForInit(onInit: (m: InitMessage) => void) {
  const onMsg = (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'scopeio:init') return;
    hostOrigin = e.origin;
    onInit({
      mode: MODES.includes(d.mode) ? d.mode : 'solve',
      starterCode: typeof d.starterCode === 'string' ? d.starterCode : '',
      config: d.config && typeof d.config === 'object' ? d.config : {},
    });
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}

function post(msg: unknown) {
  if (hostOrigin && framed()) window.parent.postMessage(msg, hostOrigin);
}

let changeTimer: ReturnType<typeof setTimeout> | undefined;
export function sendChange(code: string) {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => post({ type: 'scopeio:change', code }), 800);
}

export function sendResult(payload: ResultPayload) {
  clearTimeout(changeTimer);
  post({ type: 'scopeio:result', payload });
}
