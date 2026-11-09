import type { WorkbenchMode } from '../workbench-mode.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';

const MODES = [{ value: 'window', label: 'Window mode' }, { value: 'bot', label: 'Bot mode' }] as const;

/** Choosing a mode hides the workspace holding this switch, so the arrow keys only move between the modes. */
export function WorkbenchModeSwitch({ mode, onChange }: { mode: WorkbenchMode; onChange(mode: WorkbenchMode): void }) {
  return <SegmentedControl label="Workbench mode" className="lab-workbench-mode" activation="manual" options={MODES} value={mode} onChange={onChange} />;
}
