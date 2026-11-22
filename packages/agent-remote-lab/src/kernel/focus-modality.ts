/** Programmatic focus restoration must retain the initiating input modality. */
export function trackFocusModality(document: Document): () => void {
  const root = document.documentElement;
  const documents = new Map<Document, () => void>();
  let stopped = false;
  root.dataset.inputModality = 'pointer';
  const pointer = () => { root.dataset.inputModality = 'pointer'; };
  const keyboard = (event: KeyboardEvent) => {
    if (!event.metaKey && !event.altKey && !event.ctrlKey) root.dataset.inputModality = 'keyboard';
  };

  function refresh() {
    if (stopped) return;
    const current = new Set<Document>();
    const visit = (surface: Document) => {
      if (current.has(surface)) return;
      current.add(surface);
      if (!documents.has(surface)) {
        surface.addEventListener('pointerdown', pointer, true);
        surface.addEventListener('keydown', keyboard, true);
        surface.addEventListener('load', refresh, true);
        const observer = new MutationObserver(records => {
          if (records.some(record => [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node =>
            node.nodeType === 1 && ((node as Element).matches('iframe') || (node as Element).querySelector('iframe'))))) refresh();
        });
        observer.observe(surface, { childList: true, subtree: true });
        documents.set(surface, () => {
          surface.removeEventListener('pointerdown', pointer, true);
          surface.removeEventListener('keydown', keyboard, true);
          surface.removeEventListener('load', refresh, true);
          observer.disconnect();
        });
      }
      for (const frame of Array.from(surface.querySelectorAll('iframe'))) {
        try {
          // WindowProxy access gives a catchable error when the frame has navigated across origins.
          const child = frame.contentWindow?.document;
          if (child) visit(child);
        } catch { /* Cross-origin frames own their input handling. */ }
      }
    };
    visit(document);
    for (const [surface, detach] of documents) {
      if (!current.has(surface)) { detach(); documents.delete(surface); }
    }
  }

  refresh();
  return () => {
    stopped = true;
    for (const detach of documents.values()) detach();
    documents.clear();
    delete root.dataset.inputModality;
  };
}
