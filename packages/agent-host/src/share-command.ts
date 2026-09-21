import { controllerPath } from '@agent-remote-controller/agent-remote-hosted/controller-location';
import type { RemoteCatalogPage, RemoteSessionSummary } from '@agent-remote-controller/agent-remote-relay';

export interface ShareContext {
  serverUrl: string;
  hostId: string;
  providers: Array<{ providerId: string; displayName: string }>;
}
export interface ShareIO {
  write(text: string): void;
  ask(prompt: string): Promise<string>;
  qr(url: string): Promise<string>;
}
export type ShareRequest = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

export async function runShare(args: string[], request: ShareRequest, io: ShareIO): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== 'list-sessions')) throw new Error('Usage: agent-remote-controller share [list-sessions]');
  const context = await request({ action: 'share-context' }) as unknown as ShareContext;
  if (!context.hostId || !Array.isArray(context.providers) || !context.providers.length) {
    throw new Error('This Controller cannot share sessions. Update and restart it, then try again.');
  }
  const site = new URL(context.serverUrl);
  if (!['https:', 'http:'].includes(site.protocol) || site.username || site.password || site.search || site.hash || site.pathname !== '/') {
    throw new Error('The configured Controller site must be an HTTP(S) origin without credentials.');
  }
  // Use the same identity validation as browser links before showing anything from the daemon.
  for (const provider of context.providers) controllerPath({ hostId: context.hostId, providerId: provider.providerId, nativeSessionId: 'validation' });
  io.write(`Share a session on ${site.origin}\nEnter q at any prompt to cancel.\n`);
  const catalog = async (providerId: string, query: { nativeSessionId?: string; cursor?: string } = {}) => {
    const result = await request({ action: 'share-catalog', serverUrl: context.serverUrl, hostId: context.hostId, providerId, ...query });
    if (result.status === 404 && query.nativeSessionId) return undefined;
    if (result.status !== 200) throw new Error(result.status === 409
      ? 'The session list expired. Run share list-sessions again.'
      : `Could not read the ${safe(providerId)} session catalog. Check the Controller connection and retry.`);
    return JSON.parse(String(result.body));
  };
  const validate = async (providerId: string, id: string): Promise<RemoteSessionSummary | undefined> => {
    controllerPath({ hostId: context.hostId, providerId, nativeSessionId: id });
    io.write('Checking session…\n');
    const value = await catalog(providerId, { nativeSessionId: id }) as RemoteSessionSummary | undefined;
    if (!value) { io.write('Session not found in this Host’s catalog. Check the ID and provider, then try again.\n'); return; }
    if (value.providerId !== providerId || value.nativeSessionId !== id || value.state === 'unavailable') {
      throw new Error('The selected session is no longer available. Run share again.');
    }
    return value;
  };
  let selected: RemoteSessionSummary | undefined;
  if (args[0] === 'list-sessions') {
    selected = await chooseRecent(context, catalog, validate, io);
  } else {
    io.write('\nProviders on this Host:\n');
    context.providers.forEach((provider, index) => io.write(`  ${index + 1}. ${safe(provider.displayName)} (${provider.providerId})\n`));
    let provider: ShareContext['providers'][number] | undefined;
    while (!provider) {
      const answer = (await io.ask('Choose provider number or name: ')).trim();
      if (cancelled(answer)) return cancel(io);
      provider = context.providers.find(value => value.providerId === answer)
        ?? (/^[1-9]\d*$/.test(answer) ? context.providers[Number(answer) - 1] : undefined);
      if (!provider) io.write('Choose one of the providers listed above.\n');
    }
    io.write(provider.providerId === 'codex'
      ? 'In Codex, run /status and copy the Session value. Paste only the session ID below.\n'
      : `Copy the session ID from ${safe(provider.displayName)}. To browse IDs instead, run agent-remote-controller share list-sessions.\n`);
    while (!selected) {
      const id = (await io.ask('Session ID: ')).trim();
      if (cancelled(id)) return cancel(io);
      if (!id || id.length > 4096 || /[\u0000-\u001f\u007f]/.test(id)) { io.write('Enter a non-empty session ID.\n'); continue; }
      selected = await validate(provider.providerId, id);
    }
  }
  if (!selected) return;
  const url = site.origin + controllerPath({ hostId: context.hostId, providerId: selected.providerId, nativeSessionId: selected.nativeSessionId });
  const qr = await io.qr(url);
  io.write(`\n${safe(selected.title || selected.nativeSessionId)} (${safe(selected.providerId)})\n${url}\n\n${qr}\n`);
  io.write('On your phone, open this site and use Scan to open. The receiving device uses its own sign-in and Host access.\n');
}

async function chooseRecent(context: ShareContext,
  catalog: (providerId: string, query?: { cursor?: string }) => Promise<RemoteCatalogPage>,
  validate: (providerId: string, id: string) => Promise<RemoteSessionSummary | undefined>, io: ShareIO): Promise<RemoteSessionSummary | undefined> {
  const sources = context.providers.map(provider => ({ providerId: provider.providerId, items: [] as RemoteSessionSummary[],
    cursor: undefined as string | undefined, more: true }));
  // Merge sorted provider pages so a busy provider cannot hide another provider's recent sessions.
  async function nextPage() {
    const page: RemoteSessionSummary[] = [];
    while (page.length < 20) {
      await Promise.all(sources.map(async source => {
        if (source.items.length || !source.more) return;
        const result = await catalog(source.providerId, { cursor: source.cursor });
        if (!Array.isArray(result.items) || result.items.some(item => item.providerId !== source.providerId)
          || (result.hasMore && (!result.nextCursor || result.nextCursor === source.cursor || !result.items.length))) {
          throw new Error('The Host returned an invalid session page. Run share again.');
        }
        source.items = result.items; source.cursor = result.nextCursor; source.more = result.hasMore;
      }));
      const source = sources.filter(value => value.items.length).sort((a, b) => compare(a.items[0]!, b.items[0]!))[0];
      if (!source) break;
      page.push(source.items.shift()!);
    }
    return page;
  }
  io.write('Loading recent sessions…\n');
  let page = await nextPage();
  if (!page.length) { io.write('No sessions found on this Host.\n'); return; }
  while (true) {
    io.write('\nRecent sessions (newest first):\n');
    page.forEach((item, index) => io.write(`  ${index + 1}. [${safe(item.providerId)}] ${safe(item.title || item.nativeSessionId)}\n`
      + `     ${safe(item.nativeSessionId)} | ${safe(item.workspace ?? '(no directory)')} | ${safe(item.updatedAt)}\n`));
    const more = sources.some(source => source.items.length || source.more);
    const answer = (await io.ask(`Choose session number${more ? ', n for older sessions' : ''}: `)).trim();
    if (cancelled(answer)) { cancel(io); return; }
    if (answer === 'n' && more) { page = await nextPage(); if (!page.length) { io.write('No more sessions.\n'); return; } continue; }
    const item = /^[1-9]\d*$/.test(answer) ? page[Number(answer) - 1] : undefined;
    if (!item) { io.write('Choose a session from this page.\n'); continue; }
    const verified = await validate(item.providerId, item.nativeSessionId);
    if (verified) return verified;
  }
}
function compare(a: RemoteSessionSummary, b: RemoteSessionSummary) {
  const time = (item: RemoteSessionSummary) => Date.parse(item.updatedAt) || Date.parse(item.createdAt) || 0;
  return time(b) - time(a) || a.providerId.localeCompare(b.providerId) || a.nativeSessionId.localeCompare(b.nativeSessionId);
}
function safe(text: string): string { return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
function cancelled(text: string): boolean { return text.toLowerCase() === 'q'; }
function cancel(io: ShareIO): void { io.write('Sharing cancelled.\n'); }
