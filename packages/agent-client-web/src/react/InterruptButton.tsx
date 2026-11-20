/**
 * The composer's stop button, beside send while a turn or a command runs: it interrupts the native operation. Its label says whether
 * an interrupt is in flight or was asked for; it is disabled while the session cannot take one.
 */
export function InterruptButton({ shown, disabled, label, title, onInterrupt }: { shown: boolean; disabled: boolean; label: string; title: string; onInterrupt(): void }) {
  return <button type="button" className="agent-composer-stop" data-testid="cancel-submit" hidden={!shown} disabled={disabled} aria-label={label} title={title} onClick={onInterrupt}>
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></svg>
  </button>;
}
