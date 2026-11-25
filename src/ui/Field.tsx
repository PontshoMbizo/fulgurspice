import { useEffect, useRef, useState } from 'react';

/** Text field that commits on blur or Enter, so typing a value is one undo step. */
export function Field({ label, value, hint, mono, onCommit }: { label: string; value: string; hint?: string; mono?: boolean; onCommit: (v: string) => void }) {
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
