import { describe, expect, it } from 'vitest';
import { returnKeyAction, type ReturnKeyAction } from './return-key.js';

const rows: Array<[string, { coarsePointer: boolean; shift: boolean; composing: boolean; modifier: boolean }, ReturnKeyAction]> = [
  ['fine pointer sends', { coarsePointer: false, shift: false, composing: false, modifier: false }, 'send'],
  ['fine pointer Shift makes a line', { coarsePointer: false, shift: true, composing: false, modifier: false }, 'newline'],
  ['fine pointer with a modifier sends', { coarsePointer: false, shift: false, composing: false, modifier: true }, 'send'],
  ['fine pointer Shift with a modifier makes a line', { coarsePointer: false, shift: true, composing: false, modifier: true }, 'newline'],
  ['coarse pointer makes a line', { coarsePointer: true, shift: false, composing: false, modifier: false }, 'newline'],
  ['coarse pointer Shift makes a line', { coarsePointer: true, shift: true, composing: false, modifier: false }, 'newline'],
  ['coarse pointer with a modifier sends', { coarsePointer: true, shift: false, composing: false, modifier: true }, 'send'],
  ['composing fine ignores', { coarsePointer: false, shift: false, composing: true, modifier: false }, 'ignore'],
  ['composing coarse ignores', { coarsePointer: true, shift: false, composing: true, modifier: true }, 'ignore'],
];

it.each(rows)('%s', (_name, facts, action) => { expect(returnKeyAction(facts)).toBe(action); });
