import { controllerPath } from '@orchardworks/agent-remote-hosted/controller-location';
import type { RemoteSessionSummary } from '@orchardworks/agent-remote-relay';
import { ShareCatalog, type ReadShareCatalog } from './share-catalog.js';
import { browseShareSessions } from './share-browser.js';

export interface ShareContext {
  serverUrl: string;
  hostId: string;
  providers: Array<{ providerId: string; displayName: string }>;
}
export interface ShareChoice {
  value: string;
  label: string;
  description?: string[];
  shortcut?: string;
}
export interface ShareIO {
  write(text: string): void;
  ask(prompt: string): Promise<string>;
  qr(url: string): Promise<string>;
  select?(prompt: string, choices: readonly ShareChoice[]): Promise<string | undefined>;
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
    let provider: ShareContext['providers'][number] | undefined;
    if (io.select) {
      const choice = await io.select('Providers on this Host', context.providers.map(value => ({
        value: value.providerId, label: safe(value.displayName), description: [`Provider: ${value.providerId}`],
      })));
      if (choice === undefined) return cancel(io);
      provider = context.providers.find(value => value.providerId === choice);
      if (!provider) throw new Error('The selected provider is no longer available. Run share again.');
    } else {
      io.write('\nProviders on this Host:\n');
      context.providers.forEach((value, index) => io.write(`  ${index + 1}. ${safe(value.displayName)} (${value.providerId})\n`));
    }
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

async function chooseRecent(context: ShareContext, read: ReadShareCatalog,
  validate: (providerId: string, id: string) => Promise<RemoteSessionSummary | undefined>, io: ShareIO): Promise<RemoteSessionSummary | undefined> {
  const catalog = new ShareCatalog(context.providers, read);
  if (io.select) return browseShareSessions(catalog, io, validate);
  io.write('Loading recent sessions…\n');
  let pageIndex = 0;
  if (!(await catalog.page(0)).length) { io.write('No sessions found on this Host.\n'); return; }
  while (true) {
    const page = await catalog.page(pageIndex);
    const more = catalog.hasMore(pageIndex);
    io.write('\nRecent sessions (newest first):\n');
    page.forEach((item, index) => io.write(`  ${index + 1}. [${safe(item.providerId)}] ${safe(item.title || item.nativeSessionId)}\n`
      + `     ${safe(item.nativeSessionId)} | ${safe(item.workspace ?? '(no directory)')} | ${safe(item.updatedAt)}\n`));
    const answer = (await io.ask(`Choose session number${more ? ', n for older sessions' : ''}${pageIndex ? ', p for newer sessions' : ''}: `)).trim();
    if (cancelled(answer)) { cancel(io); return; }
    if (answer === 'p' && pageIndex > 0) { pageIndex--; continue; }
    if (answer === 'n' && more) {
      if ((await catalog.page(pageIndex + 1)).length) pageIndex++;
      else io.write('No more sessions.\n');
      continue;
    }
    const item = /^[1-9]\d*$/.test(answer) ? page[Number(answer) - 1] : undefined;
    if (!item) { io.write('Choose a session from this page.\n'); continue; }
    const verified = await validate(item.providerId, item.nativeSessionId);
    if (verified) return verified;
  }
}
function safe(text: string): string { return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
function cancelled(text: string): boolean { return text.toLowerCase() === 'q'; }
function cancel(io: ShareIO): void { io.write('Sharing cancelled.\n'); }
