/**
 * Mode steps: work that search or the palette queues for when a Workbench mode is in front.
 *
 * Contract
 * - Pure. A step names the mode it needs and whether it edits the open Window (`confirmed`).
 * - Entering Window mode restores the page's Window, which would supersede a Window opened or created in the same turn,
 *   so the shell drains the queue after the mode has rendered, never in the turn that switches.
 * - A step for another mode than the one shown is dropped.
 * - A confirmed step in Window mode waits until the Window is confirmed, since a cached Window shown while it loads is
 *   read-only; in Bot mode it runs at once.
 * - Steps run in the order they were queued.
 */
export interface ModeStep<Mode extends string = string> { readonly mode: Mode; run(): void; readonly confirmed: boolean }

export interface DrainResult<Mode extends string> { readonly run: readonly ModeStep<Mode>[]; readonly waiting: readonly ModeStep<Mode>[] }

export function drainModeSteps<Mode extends string>(steps: readonly ModeStep<Mode>[], shown: { readonly mode: Mode; readonly windowMode: Mode; readonly windowConfirmed: boolean }): DrainResult<Mode> {
  const run: ModeStep<Mode>[] = [], waiting: ModeStep<Mode>[] = [];
  for (const step of steps) {
    if (step.mode !== shown.mode) continue;
    if (step.confirmed && step.mode === shown.windowMode && !shown.windowConfirmed) waiting.push(step);
    else run.push(step);
  }
  return { run, waiting };
}
