const selector = '[data-entry-key]';

/** Index only rendered entries; geometry is read lazily so reflow cannot stale it. */
export class TimelineEntryIndex {
  private root?: HTMLElement;
  private observer?: MutationObserver;
  private dirty = true;
  private entries: HTMLElement[] = [];
  private keys = new Map<string, HTMLElement>();
  private current = 0;

  refresh(root: HTMLElement): this {
    if (this.root !== root) {
      this.dispose();
      this.root = root;
      this.dirty = true;
      this.observer = new MutationObserver(records => this.changed(records));
      this.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-entry-key'] });
    }
    this.changed(this.observer?.takeRecords() ?? []);
    if (this.dirty) {
      this.entries = Array.from(root.querySelectorAll<HTMLElement>(selector));
      this.keys = new Map(this.entries.map(entry => [entry.dataset.entryKey!, entry]));
      this.current = Math.min(this.current, Math.max(0, this.entries.length - 1));
      this.dirty = false;
    }
    return this;
  }
  private changed(records: MutationRecord[]): void {
    if (this.dirty) return;
    this.dirty = records.some(record => record.type === 'attributes' || [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
      .some(node => node instanceof Element && (node.matches(selector) || !!node.querySelector(selector))));
  }
  get(key: string): HTMLElement | undefined { return this.keys.get(key); }
  at(top: number): HTMLElement | undefined {
    for (const index of [this.current, this.current - 1, this.current + 1]) {
      const entry = this.entries[index];
      if (!entry) continue;
      const bounds = entry.getBoundingClientRect();
      if (bounds.top <= top && bounds.bottom > top) { this.current = index; return entry; }
    }
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.entries[middle]!.getBoundingClientRect().bottom > top) high = middle;
      else low = middle + 1;
    }
    this.current = low;
    return this.entries[low];
  }
  dispose(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.root = undefined;
    this.entries = [];
    this.keys.clear();
  }
}
