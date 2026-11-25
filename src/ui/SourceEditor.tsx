// Fields for a V or I source. The text in the value field stays the source of truth: this
// reads it, and writes it back through formatSource.

import { WAVE_DEFAULTS, WAVE_FIELDS, formatSource, parseSource, type SourceSpec, type Wave } from '../core/source';
import { Field } from './Field';

export function SourceEditor({ value, unit, onCommit }: { value: string; unit: 'V' | 'A'; onCommit: (v: string) => void }) {
  const spec = parseSource(value);
  if (!spec) return <p className="hint">This value uses syntax the source editor does not cover: edit it as text above.</p>;
  const set = (patch: Partial<SourceSpec>) => onCommit(formatSource({ ...spec, ...patch }));
  const { wave, ac } = spec;
  const setArg = (i: number, v: string) => {
    const args = Array.from({ length: Math.max(wave!.args.length, i + 1) }, (_, k) => wave!.args[k] ?? '');
    args[i] = v.trim();
    set({ wave: { type: wave!.type, args } });
  };
  return (
    <>
      <label className="param">
        <span>Waveform</span>
        <select value={wave?.type ?? 'DC'} onChange={(e) => {
          const type = e.target.value as Wave | 'DC';
          // A plain level that is replaced by a waveform would be ignored in a transient, so drop it.
          if (type === 'DC') set({ wave: null, dc: spec.dc || '0' });
          else set({ dc: '', wave: { type, args: WAVE_DEFAULTS[type] } });
        }}>
          <option value="DC">DC only</option>
          <option value="SIN">Sine</option>
          <option value="PULSE">Pulse</option>
          <option value="PWL">Piecewise linear</option>
        </select>
      </label>
      <Field label={`DC value (${unit})`} value={spec.dc} mono hint={wave ? 'Optional: the level used for the operating point and AC' : undefined} onCommit={(v) => set({ dc: v.trim() })} />
      {wave && wave.type !== 'PWL' && WAVE_FIELDS[wave.type].map((label, i) => (
        <Field key={`${wave.type}${i}`} label={label} value={wave.args[i] ?? ''} mono onCommit={(v) => setArg(i, v)} />
      ))}
      {wave?.type === 'PWL' && (
        <Field label="Time, value pairs" value={wave.args.join(' ')} mono hint={`Seconds then ${unit}, e.g. 0 0 1m 5`} onCommit={(v) => set({ wave: { type: 'PWL', args: v.split(/[\s,]+/).filter(Boolean) } })} />
      )}
      <label className="check">
        <input type="checkbox" checked={!!ac} onChange={(e) => set({ ac: e.target.checked ? { mag: '1', phase: '' } : null })} /> AC sweep stimulus
      </label>
      {ac && <>
        <Field label={`AC magnitude (${unit})`} value={ac.mag} mono onCommit={(v) => set({ ac: { ...ac, mag: v.trim() } })} />
        <Field label="AC phase (deg)" value={ac.phase} mono onCommit={(v) => set({ ac: { ...ac, phase: v.trim() } })} />
      </>}
    </>
  );
}
