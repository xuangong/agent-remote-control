import type { RemoteCatalogPage, RemoteSessionSummary } from '@agent-remote-controller/agent-remote-relay';

export type ReadShareCatalog = (providerId: string, query?: { cursor?: string }) => Promise<RemoteCatalogPage>;

/** Cache metadata pages for one share invocation, preserving provider/session identities. */
export class ShareCatalog {
  private readonly pages: RemoteSessionSummary[][] = [];
  private readonly sources;

  constructor(providers: readonly { providerId: string }[], private readonly read: ReadShareCatalog) {
    this.sources = providers.map(provider => ({ providerId: provider.providerId, items: [] as RemoteSessionSummary[],
      cursor: undefined as string | undefined, more: true, cursors: new Set<string>() }));
  }

  hasMore(index: number): boolean {
    return index < this.pages.length - 1 || this.sources.some(source => source.items.length || source.more);
  }

  async page(index: number): Promise<RemoteSessionSummary[]> {
    while (this.pages.length <= index && this.hasMore(this.pages.length - 1)) this.pages.push(await this.nextPage());
    return this.pages[index] ?? [];
  }

  async all(progress: (count: number) => void): Promise<RemoteSessionSummary[]> {
    let count = this.pages.reduce((sum, page) => sum + page.length, 0);
    progress(count);
    while (this.hasMore(this.pages.length - 1)) {
      count += (await this.page(this.pages.length)).length;
      progress(count);
    }
    return this.pages.flat();
  }

  // Merge sorted provider pages so a busy provider cannot hide another provider's recent sessions.
  private async nextPage(): Promise<RemoteSessionSummary[]> {
    const page: RemoteSessionSummary[] = [];
    while (page.length < 20) {
      await Promise.all(this.sources.map(async source => {
        if (source.items.length || !source.more) return;
        const result = await this.read(source.providerId, { cursor: source.cursor });
        if (!Array.isArray(result.items) || result.items.some(item => item.providerId !== source.providerId)
          || (result.hasMore && (!result.nextCursor || source.cursors.has(result.nextCursor) || !result.items.length))) {
          throw new Error('The Host returned an invalid session page. Run share again.');
        }
        if (result.nextCursor) source.cursors.add(result.nextCursor);
        source.items = result.items; source.cursor = result.nextCursor; source.more = result.hasMore;
      }));
      const source = this.sources.filter(value => value.items.length).sort((a, b) => compare(a.items[0]!, b.items[0]!))[0];
      if (!source) break;
      page.push(source.items.shift()!);
    }
    return page;
  }
}

function compare(a: RemoteSessionSummary, b: RemoteSessionSummary) {
  const time = (item: RemoteSessionSummary) => Date.parse(item.updatedAt) || Date.parse(item.createdAt) || 0;
  return time(b) - time(a) || a.providerId.localeCompare(b.providerId) || a.nativeSessionId.localeCompare(b.nativeSessionId);
}
