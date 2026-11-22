import { describe, expect, it } from 'vitest';
import { QUOTE_LIMIT, quoteInsertion } from './composer-quote.js';

describe('quoteInsertion', () => {
  const long = Array.from({ length: 60 }, (_, index) => `Line ${index + 1} of a long answer that goes on.`).join('\n');
  it.each([
    { name: 'a one-line message into an empty draft', message: 'Ship it', draft: '', text: '> Ship it\n\n' },
    { name: 'every line is quoted, an empty line as a bare mark', message: 'First\n\nSecond', draft: '', text: '> First\n>\n> Second\n\n' },
    { name: 'trailing space and leading blank lines go', message: '\n\n  Indented\nlast  \n\n', draft: '', text: '>   Indented\n> last\n\n' },
    { name: 'a draft with text gets a blank line first', message: 'Ship it', draft: 'About this:', text: '\n\n> Ship it\n\n' },
    { name: 'a draft ending in a line break gets one more', message: 'Ship it', draft: 'About this:\n', text: '\n> Ship it\n\n' },
    { name: 'a draft ending in a blank line gets none', message: 'Ship it', draft: 'About this:\n\n', text: '> Ship it\n\n' },
    { name: 'a draft of spaces counts as empty', message: 'Ship it', draft: '   ', text: '> Ship it\n\n' },
    { name: 'Markdown stays as written inside the quote', message: '- **One**\n- `two`', draft: '', text: '> - **One**\n> - `two`\n\n' },
    { name: 'an empty message adds nothing', message: '  \n ', draft: 'Hi', text: '' },
  ])('$name', ({ message, draft, text }) => {
    expect(quoteInsertion(message, draft)).toBe(text);
  });

  it('cuts a long message at a line break before the limit and marks the cut', () => {
    const text = quoteInsertion(long, '');
    expect(text.length).toBeLessThan(QUOTE_LIMIT + 200);
    expect(text.endsWith('goes on.…\n\n')).toBe(true);
    expect(text.split('\n').filter(line => line.startsWith('> Line')).length).toBeLessThan(60);
  });

  it('cuts one very long line at the limit itself', () => {
    const text = quoteInsertion('x'.repeat(QUOTE_LIMIT * 2), '');
    expect(text).toBe(`> ${'x'.repeat(QUOTE_LIMIT)}…\n\n`);
  });
});
