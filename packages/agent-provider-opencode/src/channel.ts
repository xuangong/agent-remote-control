import type { ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
export class ObservationChannel implements AsyncIterable<ProviderStreamItem> {
  private readonly items: ProviderStreamItem[] = [];
  private wake?: () => void;
  private closed = false;
  push(item: ProviderStreamItem): void { if (!this.closed) { this.items.push(item); this.wake?.(); this.wake = undefined; } }
  close(): void { this.closed = true; this.wake?.(); this.wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncIterator<ProviderStreamItem> {
    while (!this.closed || this.items.length) {
      if (this.items.length) { yield this.items.shift()!; continue; }
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
