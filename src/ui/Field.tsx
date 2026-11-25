import { useEffect, useRef, useState } from 'react';

/** Local text that commits on blur or Enter (Escape reverts), so typing a value is one undo step. */
function useCommitText(value: string, onCommit: (v: string) => void) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const cancelled = useRef(false);
  const commit = () => { if (cancelled.current) { cancelled.current = false; return; } if (text !== value) onCommit(text); };
  return {
    value: text,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Enter only blurs: the blur handler commits, so one edit is exactly one undo step.
      if (e.key === 'Enter') e.currentTarget.blur();
      else if (e.key === 'Escape') { cancelled.current = true; setText(value); e.currentTarget.blur(); }
    },
  };
}

/** Labelled field for the Properties panel. */
export function Field({ label, value, hint, mono, onCommit }: { label: string; value: string; hint?: string; mono?: boolean; onCommit: (v: string) => void }) {
  const input = useCommitText(value, onCommit);
  return (
    <label className="param">
      <span>{label}</span>
      <input className={mono ? 'num' : undefined} {...input} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Compact label-then-input field for the toolbar's run settings. */
export function InlineField({ label, value, title, className, onCommit }: { label: string; value: string; title?: string; className?: string; onCommit: (v: string) => void }) {
  const input = useCommitText(value, onCommit);
  return (
    <label className={className} title={title}>
      {label}
      <input {...input} />
    </label>
  );
}
