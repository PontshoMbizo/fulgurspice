// Asks for one name (a new subcircuit's) and says what is wrong with it as you type.

import { useState } from 'react';
import { Overlay } from './Overlay';

export function NamePrompt({ title, problem, onSubmit, onClose }: { title: string; problem: (name: string) => string | null; onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const why = name ? problem(name) : null;
  const submit = () => { if (!problem(name)) onSubmit(name.trim()); };
  return (
    <Overlay onClose={onClose}>
      <div className="overlay-title">{title}</div>
      <div>
        <input
          autoFocus aria-label="Name" value={name} placeholder="e.g. RCSTAGE, Buffer, H_bridge"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <div className="overlay-empty" role="status" style={{ padding: '4px 0', minHeight: 16, color: why ? 'var(--danger)' : undefined }}>{why ?? ''}</div>
      </div>
      <div className="overlay-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!name || !!problem(name)} onClick={submit}>Create</button>
      </div>
    </Overlay>
  );
}
