import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { sessionTerminal } from './session-terminal.js';

function terminal(tty: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY: tty }), output = Object.assign(new PassThrough(), { isTTY: tty });
  let shown = '';
  output.on('data', chunk => { shown += String(chunk); });
  return { input, shown: () => shown, terminal: sessionTerminal(input, output) };
}

describe('the terminal that picks a session', () => {
  it('is interactive only when input and output are terminals', () => {
    expect(terminal(true).terminal.interactive).toBe(true);
    expect(terminal(false).terminal.interactive).toBe(false);
  });

  it('shows the numbered lines and returns the number typed', async () => {
    const { input, shown, terminal: person } = terminal(true);
    const chosen = person.choose(['1. A', '2. B']);
    input.write('2\n');
    expect(await chosen).toBe(2);
    expect(shown()).toContain('1. A\n2. B');
    expect(shown()).toContain('Which session (1-2');
  });

  it.each(['\n', 'abc\n', '2x\n'])('returns nothing for the answer %j', async answer => {
    const { input, terminal: person } = terminal(true);
    const chosen = person.choose(['1. A', '2. B']);
    input.write(answer);
    expect(await chosen).toBeUndefined();
  });

  it('writes progress notes to the output', () => {
    const { shown, terminal: person } = terminal(true);
    person.note('Asking Codex…');
    expect(shown()).toBe('Asking Codex…\n');
  });
});
