import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { TargetTerminal } from './session-target.js';

/** The person at this terminal: questions go to standard error so that standard output stays the JSON result. */
export function sessionTerminal(input: Readable & { isTTY?: boolean } = process.stdin, output: Writable & { isTTY?: boolean } = process.stderr): TargetTerminal {
  return {
    interactive: input.isTTY === true && output.isTTY === true,
    note: text => { output.write(`${text}\n`); },
    async choose(lines) {
      output.write(`${lines.join('\n')}\n`);
      const reader = createInterface({ input, output, terminal: false });
      try {
        const answer = (await reader.question(`Which session (1-${lines.length}, Enter to cancel)? `)).trim();
        return /^\d{1,3}$/.test(answer) ? Number(answer) : undefined;
      } finally { reader.close(); }
    },
  };
}
