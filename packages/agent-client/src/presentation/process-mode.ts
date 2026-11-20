/**
 * The process modes: how much of a turn's work shows (I3 plan, decision 2 and section 4.2). One pure rule over the mode, the
 * turn's state, the reader's own toggle and a search hit; the timeline only reads it.
 *
 * - Concise: the work line is closed.
 * - Process: open while the turn runs, closed when it ends.
 * - Full: open, every step at today's preview level.
 * - A reader's toggle wins for that turn until the mode changes; a search hit inside the work opens it at preview level.
 */

export type ProcessMode = 'concise' | 'process' | 'full';
export const PROCESS_MODES: readonly ProcessMode[] = ['concise', 'process', 'full'];

/** Whether a turn's work line is open, and whether its steps show one line each (`summary`) or today's preview (`preview`). */
export interface WorkDisclosure { readonly line: 'open' | 'closed'; readonly steps: 'summary' | 'preview' }

/** `choice` is the reader's toggle for this turn (undefined until they touch it); `revealed` is a search hit inside the turn's work. */
export function workDisclosure(mode: ProcessMode, turn: 'running' | 'ended', choice?: boolean, revealed?: boolean): WorkDisclosure {
  const steps = mode === 'full' ? 'preview' : 'summary';
  if (revealed) return { line: 'open', steps: 'preview' };
  if (choice !== undefined) return { line: choice ? 'open' : 'closed', steps };
  const open = mode === 'full' || mode === 'process' && turn === 'running';
  return { line: open ? 'open' : 'closed', steps };
}

/** A stored mode (the device default, or an assistant's own); anything else reads as none. */
export function readProcessMode(stored: unknown): ProcessMode | undefined {
  return typeof stored === 'string' && (PROCESS_MODES as readonly string[]).includes(stored) ? stored as ProcessMode : undefined;
}

/** The mode a conversation shows: the assistant's own, else this device's default, else Concise. */
export function effectiveProcessMode(assistant: ProcessMode | undefined, device: ProcessMode | undefined): ProcessMode {
  return assistant ?? device ?? 'concise';
}

/**
 * What to store for an assistant when its reader picks `chosen` on a device whose default is `device`: nothing when the
 * choice is the default (the assistant then follows each device's default), the choice otherwise.
 */
export function assistantProcessChoice(chosen: ProcessMode, device: ProcessMode | undefined): ProcessMode | undefined {
  return chosen === effectiveProcessMode(undefined, device) ? undefined : chosen;
}
