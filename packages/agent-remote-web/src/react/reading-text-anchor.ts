export interface ReadingTextAnchor {
  path: number[];
  character: number;
  sample: string;
  top: number;
}

/** Keep the visible text line stable when layout changes within a long entry. */
export function captureReadingText(entry: HTMLElement, viewport: DOMRect): ReadingTextAnchor | undefined {
  if (entry.getBoundingClientRect().top >= viewport.top) return;
  const range = entry.ownerDocument.createRange();
  if (typeof range.getClientRects !== 'function') return;
  const walker = entry.ownerDocument.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent;
    if (!text?.trim() || !node.parentElement?.closest('.agent-markdown')) continue;
    range.selectNodeContents(node);
    const visible = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom);
    if (!visible) continue;
    let start = 0, end = text.length - 1;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      const rect = characterBounds(range, node, middle);
      if (!rect || rect.bottom <= viewport.top) start = middle + 1;
      else end = middle;
    }
    const rect = characterBounds(range, node, start);
    if (!rect || rect.height === 0) continue;
    const path: number[] = [];
    for (let child: Node = node; child !== entry;) {
      const parent = child.parentNode;
      if (!parent) return;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, child));
      child = parent;
    }
    return { path, character: start, sample: text.slice(start, start + 32), top: rect.top - viewport.top };
  }
}

export function readingTextTop(entry: HTMLElement, anchor: ReadingTextAnchor): number | undefined {
  // Reading positions can be restored from browser storage written by older clients.
  if (!Array.isArray(anchor.path) || anchor.path.length > 64 || !anchor.path.every(value => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(anchor.character) || anchor.character < 0 || typeof anchor.sample !== 'string' || !anchor.sample || !Number.isFinite(anchor.top)) return;
  let node: Node = entry;
  for (const index of anchor.path) {
    const child = node.childNodes[index];
    if (!child) return;
    node = child;
  }
  if (node.nodeType !== Node.TEXT_NODE || node.textContent?.slice(anchor.character, anchor.character + anchor.sample.length) !== anchor.sample) return;
  const range = entry.ownerDocument.createRange();
  if (typeof range.getClientRects !== 'function') return;
  const rect = characterBounds(range, node, anchor.character);
  return rect && rect.height > 0 ? rect.top : undefined;
}

function characterBounds(range: Range, node: Node, character: number): DOMRect | undefined {
  range.setStart(node, character);
  range.setEnd(node, character + 1);
  return range.getClientRects()[0];
}
