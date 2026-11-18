// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { drainModeSteps, type ModeStep } from './mode-steps.js';

type Mode = 'window' | 'bot';
const step = (name: string, mode: Mode, confirmed = false): ModeStep<Mode> & { name: string } => ({ name, mode, confirmed, run() {} });
const names = (steps: readonly ModeStep<Mode>[]) => steps.map(item => (item as ReturnType<typeof step>).name);
const shown = (mode: Mode, windowConfirmed: boolean) => ({ mode, windowMode: 'window' as const, windowConfirmed });

describe('draining mode steps', () => {
  it('runs the steps of the shown mode in queue order', () => {
    const result = drainModeSteps([step('a', 'bot'), step('b', 'bot'), step('c', 'bot')], shown('bot', true));
    expect(names(result.run)).toEqual(['a', 'b', 'c']);
    expect(result.waiting).toEqual([]);
  });

  it('drops a step for the mode that is not shown', () => {
    const result = drainModeSteps([step('a', 'window'), step('b', 'bot')], shown('bot', true));
    expect(names(result.run)).toEqual(['b']);
    expect(result.waiting).toEqual([]);
  });

  it('holds a Window edit until the Window is confirmed, and lets other steps pass it', () => {
    const queue = [step('edit', 'window', true), step('focus', 'window')];
    const early = drainModeSteps(queue, shown('window', false));
    expect(names(early.run)).toEqual(['focus']);
    expect(names(early.waiting)).toEqual(['edit']);
    expect(names(drainModeSteps(early.waiting, shown('window', true)).run)).toEqual(['edit']);
  });

  it('does not make a Bot mode step wait for the Window', () => {
    expect(names(drainModeSteps([step('edit', 'bot', true)], shown('bot', false)).run)).toEqual(['edit']);
  });
});
