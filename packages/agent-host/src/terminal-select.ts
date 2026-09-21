import { emitKeypressEvents, type Key } from 'node:readline';
import type { ShareChoice } from './share-command.js';

/** A shared keyboard selector for interactive CLI choices; text prompts use readline. */
export async function selectTerminalChoice(prompt: string, choices: readonly ShareChoice[]): Promise<string | undefined> {
  if (!choices.length) return undefined;
  const input = process.stdin, output = process.stdout;
  const wasRaw = input.isRaw, wasFlowing = input.readableFlowing;
  let selected = 0, offset = 0;
  let finish: (value: string | undefined) => void;
  let fail: (error: Error) => void;
  const render = () => {
    const width = Math.max(1, (output.columns || 80) - 1);
    const height = Math.max(3, (output.rows || 24) - 1);
    const description = choices[selected]!.description ?? [];
    const details = description.slice(0, Math.max(0, Math.min(3, height - 6)));
    const capacity = Math.max(1, height - details.length - 4);
    offset = Math.max(0, Math.min(offset, selected, choices.length - capacity));
    if (selected >= offset + capacity) offset = selected - capacity + 1;
    const rows = [prompt];
    choices.slice(offset, offset + capacity).forEach((choice, index) => {
      const active = offset + index === selected;
      const line = fit(`${active ? '❯' : ' '} ${choice.label}`, width);
      rows.push(active ? `\u001b[7m${line}\u001b[0m` : line);
    });
    if (height >= 6) rows.push(`${selected + 1}/${choices.length}`, ...details);
    rows.push('↑/↓ Move · Enter Select · Esc/q Cancel');
    // Each physical line stays within the terminal width, including CJK titles.
    output.write('\u001b[H\u001b[J' + rows.map((line, index) =>
      index > 0 && index <= Math.min(capacity, choices.length - offset) ? line : fit(line, width)).join('\r\n'));
  };
  const keypress = (_text: string, key: Key) => {
    if (key.name === 'escape' || key.name === 'q' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
      finish(undefined); return;
    }
    if (key.name === 'return' || key.name === 'enter') { finish(choices[selected]!.value); return; }
    switch (key.name) {
      case 'up': selected = Math.max(0, selected - 1); break;
      case 'down': selected = Math.min(choices.length - 1, selected + 1); break;
      case 'home': selected = 0; break;
      case 'end': selected = choices.length - 1; break;
      case 'pageup': selected = Math.max(0, selected - 10); break;
      case 'pagedown': selected = Math.min(choices.length - 1, selected + 10); break;
      default: return;
    }
    render();
  };
  const end = () => finish(undefined);
  const error = (cause: Error) => fail(cause);
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      // Stop consuming keys as soon as a choice settles, including keys in the same chunk.
      finish = value => { input.off('keypress', keypress); resolve(value); };
      fail = reject;
      emitKeypressEvents(input);
      input.on('keypress', keypress);
      input.on('end', end);
      input.on('error', error);
      output.on('resize', render);
      input.setRawMode(true);
      input.resume();
      output.write('\u001b[?1049h\u001b[?25l');
      render();
    });
  } finally {
    input.off('keypress', keypress);
    input.off('end', end);
    input.off('error', error);
    output.off('resize', render);
    input.setRawMode(!!wasRaw);
    if (wasFlowing !== true) input.pause();
    output.write('\u001b[0m\u001b[?25h\u001b[?1049l');
  }
}

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function fit(text: string, columns: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  let result = '', used = 0;
  for (const { segment } of segments.segment(clean)) {
    const code = segment.codePointAt(0)!;
    const wide = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)
      || code >= 0x1100 && (code <= 0x115f || code >= 0x2329 && code <= 0x232a
        || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3
        || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f
        || code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6
        || code >= 0x20000 && code <= 0x3fffd);
    const size = /^\p{Mark}+$/u.test(segment) ? 0 : wide ? 2 : 1;
    if (used + size > columns) break;
    result += segment; used += size;
  }
  return result;
}
