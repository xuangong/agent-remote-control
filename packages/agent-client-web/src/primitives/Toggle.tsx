import type { KeyboardEvent } from 'react';
import { rootClass } from './classes.js';

/**
 * An on/off switch with its label. Click and Space change it; Space is handled on key down and its key up is
 * swallowed, so a browser's own button activation does not change it twice.
 */
export function Toggle({ checked, label, onChange, disabled = false, className }: {
  checked: boolean; label: string; onChange(next: boolean): void; disabled?: boolean; className?: string;
}) {
  const space = (event: KeyboardEvent<HTMLButtonElement>) => event.key === ' ' || event.key === 'Spacebar';
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={rootClass('orchard-toggle', className)}
    onClick={() => onChange(!checked)}
    onKeyDown={event => { if (!space(event)) return; event.preventDefault(); if (!disabled) onChange(!checked); }}
    onKeyUp={event => { if (space(event)) event.preventDefault(); }}>
    <span className="orchard-toggle-label">{label}</span>
    <span className="orchard-toggle-track" aria-hidden="true"><span className="orchard-toggle-thumb" /></span>
  </button>;
}
