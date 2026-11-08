import type { WorkbenchMode } from '../workbench-mode.js';

export function WorkbenchModeSwitch({ mode, onChange }: { mode: WorkbenchMode; onChange(mode: WorkbenchMode): void }) {
  return <nav className="lab-workbench-mode" aria-label="Workbench mode">
    <button type="button" aria-pressed={mode === 'window'} onClick={() => onChange('window')}>Window mode</button>
    <button type="button" aria-pressed={mode === 'bot'} onClick={() => onChange('bot')}>Bot mode</button>
  </nav>;
}
