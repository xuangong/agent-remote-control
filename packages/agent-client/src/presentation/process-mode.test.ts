import { describe, expect, it } from 'vitest';
import { assistantProcessChoice, effectiveProcessMode, PROCESS_MODES, readProcessMode, workDisclosure, type ProcessMode, type WorkDisclosure } from './process-mode.js';

const open = (steps: WorkDisclosure['steps']): WorkDisclosure => ({ line: 'open', steps });
const closed = (steps: WorkDisclosure['steps']): WorkDisclosure => ({ line: 'closed', steps });

/** The disclosure table of the I3 plan, section 4.2, row by row. */
const TABLE: ReadonlyArray<readonly [ProcessMode, 'running' | 'ended', { choice?: boolean; revealed?: boolean }, WorkDisclosure]> = [
  ['concise', 'running', {}, closed('summary')],
  ['concise', 'ended', {}, closed('summary')],
  ['process', 'running', {}, open('summary')],
  ['process', 'ended', {}, closed('summary')],
  ['full', 'running', {}, open('preview')],
  ['full', 'ended', {}, open('preview')],
  ...PROCESS_MODES.flatMap(mode => (['running', 'ended'] as const).flatMap(turn => [
    [mode, turn, { choice: true }, open(mode === 'full' ? 'preview' : 'summary')] as const,
    [mode, turn, { choice: false }, closed(mode === 'full' ? 'preview' : 'summary')] as const,
    [mode, turn, { revealed: true }, open('preview')] as const,
    [mode, turn, { choice: false, revealed: true }, open('preview')] as const,
  ])),
];

describe('workDisclosure', () => {
  it.each(TABLE)('%s, a %s turn, %j: %j', (mode, turn, { choice, revealed }, expected) => {
    expect(workDisclosure(mode, turn, choice, revealed)).toEqual(expected);
  });
});

describe('the stored mode', () => {
  it.each([['concise', 'concise'], ['process', 'process'], ['full', 'full'], ['preview', undefined], ['', undefined], [undefined, undefined], [3, undefined], [{ mode: 'full' }, undefined]] as const)(
    'reads %j as %j', (stored, mode) => { expect(readProcessMode(stored)).toBe(mode); });

  it("takes the assistant's own mode, then the device's default, then Concise", () => {
    expect(effectiveProcessMode('full', 'process')).toBe('full');
    expect(effectiveProcessMode(undefined, 'process')).toBe('process');
    expect(effectiveProcessMode(undefined, undefined)).toBe('concise');
  });

  it('stores nothing for an assistant whose reader picks the default, and the choice otherwise', () => {
    expect(assistantProcessChoice('concise', undefined)).toBeUndefined();
    expect(assistantProcessChoice('process', 'process')).toBeUndefined();
    expect(assistantProcessChoice('full', undefined)).toBe('full');
    expect(assistantProcessChoice('concise', 'full')).toBe('concise');
  });
});
