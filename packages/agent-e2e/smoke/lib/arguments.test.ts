import { describe, expect, it } from 'vitest';
import { argument, positiveInteger } from './arguments.js';

describe('command line flags of a smoke run', () => {
  it('reads the value after a flag and nothing when the flag is absent', () => {
    expect(argument('--duration', ['node', 'cli', 'M8', '--duration', '10'])).toBe('10');
    expect(argument('--duration', ['node', 'cli'])).toBeUndefined();
  });
  it('takes a positive whole number, falls back when absent and refuses anything else', () => {
    expect(positiveInteger('--sessions', 200, ['--sessions', '12'])).toBe(12);
    expect(positiveInteger('--sessions', 200, [])).toBe(200);
    for (const bad of ['0', '-3', '1.5', 'many']) expect(() => positiveInteger('--sessions', 200, ['--sessions', bad])).toThrow(/positive whole number/);
  });
});
