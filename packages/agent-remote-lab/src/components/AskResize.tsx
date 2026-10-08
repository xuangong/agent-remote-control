import { useId } from 'react';

export function AskResize() {
  const hint = useId();
  return <div className="lab-ask-resize-footer">
    <span id={hint} className="agent-visually-hidden">Drag to resize. Arrow keys adjust width and height; hold Shift for larger steps.</span>
    <button type="button" className="lab-ask-resize" aria-label="Resize Ask" aria-describedby={hint}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown" title="Resize Ask (arrow keys; Shift for larger steps)">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M5 13 13 5M9 13l4-4" />
      </svg>
    </button>
  </div>;
}
