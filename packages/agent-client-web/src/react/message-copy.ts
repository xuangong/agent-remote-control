/**
 * Copy with formatting (I5d): a message goes on the clipboard as its own text (`text/plain`, the Markdown it was written in) and,
 * where the page shows it formatted, as that formatting (`text/html`), so pasting into a document keeps the lists, emphasis, code
 * and links while a plain text field gets the Markdown. A browser without rich clipboard writes, or one that refuses them, gets
 * the text alone.
 *
 * `formattedMessage` is the HTML part: the message's own content without the page's controls and markers. It keeps the elements
 * of formatted text and only the attributes that carry meaning outside the page (a link's address, an image's address and words).
 */
const KEPT_ELEMENTS = new Set(['P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'INS', 'MARK', 'SMALL', 'SUB', 'SUP', 'CODE', 'PRE', 'KBD', 'SAMP',
  'BLOCKQUOTE', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  'CAPTION', 'SPAN', 'DIV', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY']);
const KEPT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = { A: ['href', 'title'], IMG: ['src', 'alt', 'title'], OL: ['start'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
/** The page's own parts inside a message, never its content. */
const CONTROLS = 'button, input, select, textarea, svg, [aria-hidden="true"], [hidden], .agent-entry-actions, .agent-entry-time, .agent-bubble-time';

/** Removes the page's controls and keeps only the elements of formatted text, unwrapping the others into their content. */
function keepFormatting(node: Element): void {
  for (const child of Array.from(node.children)) {
    if (child.matches(CONTROLS)) { child.remove(); continue; }
    keepFormatting(child);
    if (!KEPT_ELEMENTS.has(child.tagName)) child.replaceWith(...Array.from(child.childNodes));
  }
}

/** Keeps only the attributes that mean something on another page, and only addresses of the web. */
function keepAttributes(root: Element): void {
  for (const element of Array.from(root.querySelectorAll('*'))) {
    const kept = KEPT_ATTRIBUTES[element.tagName] ?? [];
    for (const attribute of Array.from(element.attributes)) if (!kept.includes(attribute.name)) element.removeAttribute(attribute.name);
    // No script, and no image only this page holds (blob:, or data: of a draft): an image leaves its words.
    const address = element.getAttribute('href') ?? element.getAttribute('src');
    if (address === null || /^(https?:|mailto:)/i.test(address.trim())) continue;
    if (element.tagName === 'IMG') element.replaceWith(element.getAttribute('alt') ?? '');
    else element.removeAttribute('href');
  }
}

/** The formatted part of a message the page shows in `rendered`, or nothing when it shows none. */
export function formattedMessage(rendered: Element | null | undefined): string | undefined {
  const message = rendered?.matches('.agent-message') ? rendered : rendered?.querySelector('.agent-message');
  if (!message) return undefined;
  const copy = message.cloneNode(true) as Element;
  keepFormatting(copy);
  keepAttributes(copy);
  // A message that is all unchanged text has no formatting to keep.
  const html = copy.innerHTML.trim();
  return html && copy.querySelector('*') ? html : undefined;
}

/** Puts a message on the clipboard with its formatting where it has any; rejects when the clipboard takes nothing. */
export async function copyMessage(text: string, rendered?: Element | null): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) throw new Error('The clipboard is unavailable.');
  const html = formattedMessage(rendered);
  if (html && typeof ClipboardItem !== 'undefined' && clipboard.write) {
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      return;
    } catch { /* Some browsers take only plain text from a page. */ }
  }
  await clipboard.writeText(text);
}
