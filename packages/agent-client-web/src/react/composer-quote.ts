/**
 * How a quoted message enters a draft (I5d): the message as a Markdown quote at the end of what the draft holds, then a blank line
 * to answer on. Pure: the composer passes the message and its draft's text.
 *
 * Each line of the message becomes a quoted line, and an empty line a bare `>`. A long message is cut at its last line break
 * before `QUOTE_LIMIT` characters (or at the limit when that break comes too early) and ends with an ellipsis. A draft with text
 * gets a blank line before the quote.
 */
export const QUOTE_LIMIT = 2000;

export function quoteInsertion(message: string, draft: string): string {
  let body = message.replace(/\s+$/u, '').replace(/^(?:[ \t]*\n)+/u, '');
  if (!body.trim()) return '';
  if (body.length > QUOTE_LIMIT) {
    const cut = body.lastIndexOf('\n', QUOTE_LIMIT);
    body = `${body.slice(0, cut > QUOTE_LIMIT / 2 ? cut : QUOTE_LIMIT).replace(/\s+$/u, '')}…`;
  }
  const quoted = body.split('\n').map(line => line.trim() ? `> ${line}` : '>').join('\n');
  const lead = !draft.trim() || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n';
  return `${lead}${quoted}\n\n`;
}
