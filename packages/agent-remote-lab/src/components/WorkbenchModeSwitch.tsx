import type { WorkbenchMode } from '../workbench-mode.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';

/** Segments show "Window" and "Bot" so they fit a 260px sidebar; the rest of each name stays for assistive technology. */
const MODES = [
  { value: 'window', label: <>Window<span className="agent-visually-hidden"> mode</span></> },
  { value: 'bot', label: <>Bot<span className="agent-visually-hidden"> mode</span></> },
] as const;

/** Choosing a mode hides the workspace holding this switch, so the arrow keys only move between the modes. */
export function WorkbenchModeSwitch({ mode, onChange }: { mode: WorkbenchMode; onChange(mode: WorkbenchMode): void }) {
  return <SegmentedControl label="Workbench mode" className="lab-workbench-mode" activation="manual" landmark options={MODES} value={mode} onChange={onChange} />;
}
