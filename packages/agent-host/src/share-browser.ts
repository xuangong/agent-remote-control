import type { RemoteSessionSummary } from '@agent-remote-controller/agent-remote-relay';
import type { ShareChoice, ShareIO } from './share-command.js';
import type { ShareCatalog } from './share-catalog.js';

const back = Symbol('back');
type Selection = RemoteSessionSummary | typeof back | undefined;

export async function browseShareSessions(catalog: ShareCatalog, io: ShareIO,
  validate: (providerId: string, id: string) => Promise<RemoteSessionSummary | undefined>): Promise<RemoteSessionSummary | undefined> {
  const select = io.select!;
  let all: RemoteSessionSummary[] | undefined;
  const loadAll = async () => {
    if (!all) {
      try {
        all = await catalog.all(count => io.write(`\rLoading session metadata… ${count} sessions (Ctrl+C to cancel)`));
      } finally { io.write('\n'); }
    }
    return all;
  };
  const search = async (kind: 'folder' | 'session') => {
    const query = (await io.ask(kind === 'folder'
      ? 'Search folder path (empty clears, q cancels): '
      : 'Search session title or ID (empty clears, q cancels): ')).trim();
    return query.toLowerCase() === 'q' ? undefined : query;
  };

  async function sessions(scope?: { path: string | undefined; items: RemoteSessionSummary[] }): Promise<Selection> {
    let pageIndex = 0, query = '';
    while (true) {
      const filtered = scope || query ? (scope?.items ?? await loadAll()).filter(item => matches(query, item.title, item.nativeSessionId)) : undefined;
      const page = filtered ? filtered.slice(pageIndex * 20, (pageIndex + 1) * 20) : await catalog.page(pageIndex);
      const more = filtered ? (pageIndex + 1) * 20 < filtered.length : catalog.hasMore(pageIndex);
      const choices: ShareChoice[] = page.map((item, index) => ({ value: `session:${index}`,
        label: `[${item.providerId}] ${item.title || item.nativeSessionId}`,
        description: [`Session: ${item.nativeSessionId}`, `Directory: ${item.workspace ?? '(no directory)'}`, `Updated: ${item.updatedAt}`],
      }));
      choices.push({ value: 'search', label: 'Search sessions… (/)', shortcut: '/' });
      if (query) choices.push({ value: 'clear', label: 'Clear search' });
      choices.push({ value: 'back', label: scope ? '← Back to folders (b)' : '← Browse modes (b)', shortcut: 'b' });
      addPaging(choices, pageIndex, more);
      const title = scope ? `Sessions in ${scope.path ?? '(no directory)'}` : 'Recent sessions';
      const answer = await select(`${!page.length ? 'No matches — ' : ''}${query ? `Search: ${query} — ` : ''}${title} — page ${pageIndex + 1}`, choices);
      if (answer === undefined) return;
      if (answer === 'back') return back;
      if (answer === 'search') {
        const next = await search('session');
        if (next === undefined) return;
        query = next; pageIndex = 0; continue;
      }
      if (answer === 'clear') { query = ''; pageIndex = 0; continue; }
      if (answer === 'n' && more) { pageIndex++; continue; }
      if (answer === 'p' && pageIndex > 0) { pageIndex--; continue; }
      const item = sessionIndex(answer, page);
      if (item) {
        const verified = await validate(item.providerId, item.nativeSessionId);
        if (verified) return verified;
      }
    }
  }

  async function folders(): Promise<Selection> {
    const groups = new Map<string | undefined, RemoteSessionSummary[]>();
    for (const item of await loadAll()) {
      const group = groups.get(item.workspace) ?? [];
      group.push(item); groups.set(item.workspace, group);
    }
    // Insertion order follows the newest session in each directory.
    const entries = [...groups].map(([path, items]) => ({ path, items }));
    let pageIndex = 0, query = '';
    while (true) {
      const filtered = entries.filter(entry => matches(query, entry.path ?? '(no directory)'));
      const page = filtered.slice(pageIndex * 20, (pageIndex + 1) * 20);
      const more = (pageIndex + 1) * 20 < filtered.length;
      const choices: ShareChoice[] = page.map((entry, index) => ({ value: `folder:${index}`,
        label: `${entry.path ?? '(no directory)'} (${entry.items.length})`,
        description: [`Directory: ${entry.path ?? '(no directory)'}`, `Sessions: ${entry.items.length}`,
          `Providers: ${[...new Set(entry.items.map(item => item.providerId))].join(', ')}`],
      }));
      choices.push({ value: 'search', label: 'Search folders… (/)', shortcut: '/' });
      if (query) choices.push({ value: 'clear', label: 'Clear search' });
      choices.push({ value: 'back', label: '← Browse modes (b)', shortcut: 'b' });
      addPaging(choices, pageIndex, more);
      const answer = await select(`${!page.length ? 'No matches — ' : ''}${query ? `Search: ${query} — ` : ''}Folders — page ${pageIndex + 1}`, choices);
      if (answer === undefined) return;
      if (answer === 'back') return back;
      if (answer === 'search') {
        const next = await search('folder');
        if (next === undefined) return;
        query = next; pageIndex = 0; continue;
      }
      if (answer === 'clear') { query = ''; pageIndex = 0; continue; }
      if (answer === 'n' && more) { pageIndex++; continue; }
      if (answer === 'p' && pageIndex > 0) { pageIndex--; continue; }
      const folder = /^folder:\d+$/.test(answer) ? page[Number(answer.slice(7))] : undefined;
      if (folder) {
        const result = await sessions(folder);
        if (result !== back) return result;
      }
    }
  }

  while (true) {
    const mode = await select('Browse sessions', [
      { value: 'recent', label: 'Recent sessions', description: ['Browse: recent', 'Search sessions by title or ID.'] },
      { value: 'folders', label: 'By folder', description: ['Browse: folders', 'Search folder paths, then choose a session.'] },
    ]);
    const result = mode === undefined ? undefined : mode === 'folders' ? await folders() : await sessions();
    if (result === back) continue;
    if (!result) io.write('Sharing cancelled.\n');
    return result;
  }
}

function matches(query: string, ...values: string[]): boolean {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
  const text = values.map(normalize).join('\n');
  return normalize(query).split(/\s+/).filter(Boolean).every(term => text.includes(term));
}
function addPaging(choices: ShareChoice[], page: number, more: boolean) {
  if (more) choices.push({ value: 'n', label: 'Older entries → (n)', shortcut: 'n' });
  if (page > 0) choices.push({ value: 'p', label: '← Newer entries (p)', shortcut: 'p' });
}
function sessionIndex(answer: string, page: RemoteSessionSummary[]): RemoteSessionSummary | undefined {
  return /^session:\d+$/.test(answer) ? page[Number(answer.slice(8))] : undefined;
}
