import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { SessionDirectoryClient, type OpenedSession, type SessionSummary } from '../directory-client.js';
import { ForkStore, referenceForkContext } from '../session-forks.js';
import { sessionKey } from '../session-tree.js';
import { render } from '../test/setup.js';
import { SessionDirectory } from './SessionDirectory.js';

const session = (nativeSessionId: string, title = nativeSessionId): OpenedSession => ({ hostId: 'local', providerId: 'recorded', nativeSessionId, title, agentId: nativeSessionId + '-agent' });
const source = session('source', 'Main source');
const summary: SessionSummary = { ...source, state: 'idle', createdAt: '2026-10-08', updatedAt: '2026-10-08' };
const store = () => new ForkStore('directory-relations:' + crypto.randomUUID(), sessionStorage);
function bind(targets: ForkStore, target: OpenedSession, origin = source) {
  const record = targets.prepare(referenceForkContext(origin), { sourceNativeSessionId: origin.nativeSessionId });
  targets.bind(record.id, target);
  return record.id;
}
function rows(container: HTMLElement): HTMLButtonElement[] { return [...container.querySelectorAll<HTMLButtonElement>('.lab-session-tree .lab-session-tree .lab-session-row')]; }

it('expands native subagents with distinct Ask and Side links without changing native ancestry', async () => {
  const directory = new SessionDirectoryClient('http://localhost');
  const sides = store(); const asks = store();
  const child = { ...session('child', 'Native child'), parentNativeSessionId: source.nativeSessionId, status: 'running' as const };
  const side = session('side', 'Saved side'); const ask = session('ask', 'Saved Ask');
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [summary, { ...summary, ...ask, title: ask.nativeSessionId }], hasMore: false, revision: '1' });
  bind(sides, side); bind(sides, child); bind(asks, ask);
  const unlinked = bind(sides, session('unlinked')); sides.setLinked(unlinked, false);
  bind(asks, session('foreign-source'), { ...source, hostId: 'another-host' });
  bind(asks, { ...session('foreign-target'), providerId: 'another-provider' });
  bind(asks, source);
  asks.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  const onOpenRelated = vi.fn(); const onSelect = vi.fn();
  const container = await render(<SessionDirectory directory={directory} providerId="recorded" opened={[]} known={[source, child]}
    sideStore={sides} askStore={asks} busy={false} revision={0} onOpen={() => {}} onOpenRelated={onOpenRelated} onSelect={onSelect} onClose={() => {}} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand Main source"]')!.click());
  const nested = rows(container);
  expect(nested).toHaveLength(3);
  expect(nested.map(row => row.querySelector('small')?.textContent)).toEqual([
    expect.stringContaining('Subagent · Side'), expect.stringContaining('Ask'), expect.stringContaining('Side'),
  ]);
  expect(nested[0]!.textContent).toContain('Working');
  expect(nested[1]!.querySelector('strong')?.textContent).toBe('Saved Ask');
  await act(async () => nested.find(row => row.textContent?.includes('Saved Ask'))!.click());
  expect(onOpenRelated).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'ask', providerId: 'recorded', hostId: 'local' }));
  expect(onOpenRelated.mock.calls[0]![0].parentNativeSessionId).toBeUndefined();
  expect(onSelect).not.toHaveBeenCalled();
  expect(asks.find(ask)?.target?.parentNativeSessionId).toBeUndefined();
  expect(sides.find(child)?.target?.parentNativeSessionId).toBe('source');
});

it('updates relation expansion from shared store changes and selects an already opened target', async () => {
  const directory = new SessionDirectoryClient('http://localhost');
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [summary], hasMore: false, revision: '1' });
  const asks = store(); const ask = session('shared-ask', 'Shared Ask');
  const onSelect = vi.fn(); const onOpenRelated = vi.fn();
  const container = await render(<SessionDirectory directory={directory} providerId="recorded" opened={[ask]} askStore={asks}
    activeAgentId={ask.agentId} busy={false} revision={0} onOpen={() => {}} onOpenRelated={onOpenRelated} onSelect={onSelect} onClose={() => {}} />);
  expect(container.querySelector('[aria-label="Expand Main source"]')).toBeNull();
  const relation = { id: 'shared-relation', kind: 'ask' as const, createdAt: '2026-10-08', source: { ...source, hostId: 'local' }, target: { ...ask, hostId: 'local' } };
  await act(async () => asks.setSharedRelations([relation]));
  expect(container.querySelector('[aria-label="Expand Main source"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand Main source"]')!.click());
  expect(rows(container)).toHaveLength(1);
  expect(rows(container)[0]!.getAttribute('aria-current')).toBe('page');
  await act(async () => rows(container)[0]!.click());
  expect(onSelect).toHaveBeenCalledWith(ask);
  expect(onOpenRelated).not.toHaveBeenCalled();
  expect(container.querySelector(`[data-session-key='${sessionKey(source)}']`)).not.toBeNull();
  await act(async () => asks.setSharedRelations([{ ...relation, linked: false, revision: 1 }]));
  expect(rows(container)).toHaveLength(0);
  expect(container.querySelector('[aria-label="Collapse Main source"]')).toBeNull();
});

it('finds a linked target outside the catalog page and combines duplicate relationship labels', async () => {
  const directory = new SessionDirectoryClient('http://localhost');
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [summary], hasMore: false, revision: '1' });
  const sides = store(); const asks = store(); const target = session('target', 'Research findings');
  bind(sides, target); bind(asks, target); bind(asks, target);
  const container = await render(<SessionDirectory searchable directory={directory} providerId="recorded" opened={[]}
    sideStore={sides} askStore={asks} busy={false} revision={0} onOpen={() => {}} onOpenRelated={() => {}} onSelect={() => {}} onClose={() => {}} />);
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Research');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelector('[aria-label="Collapse Main source"]')).not.toBeNull();
  expect(rows(container)).toHaveLength(1);
  expect(rows(container)[0]!.querySelector('strong')?.textContent).toBe('Research findings');
  expect(rows(container)[0]!.querySelector('small')?.textContent).toBe('Ask · Side · recorded');
});

it.each(['snapshot', undefined] as const)('keeps an ordinary %s fork in the catalog without labeling it as a Side relation', async mode => {
  const directory = new SessionDirectoryClient('http://localhost');
  const target = session('snapshot-fork', 'Captured conversation');
  const targetSummary: SessionSummary = { ...summary, ...target };
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [summary, targetSummary], hasMore: false, revision: '1' });
  const sides = store();
  const record = sides.prepare({ mode, source, capturedAt: '2026-10-08', boundary: { epoch: 'epoch', seq: 1 }, itemCount: 0, text: '[]' });
  sides.bind(record.id, target);
  const onOpen = vi.fn();
  const container = await render(<SessionDirectory directory={directory} providerId="recorded" opened={[]} sideStore={sides}
    busy={false} revision={0} onOpen={onOpen} onOpenRelated={() => {}} onSelect={() => {}} onClose={() => {}} />);
  expect(container.querySelector('[aria-label="Expand Main source"]')).toBeNull();
  expect(rows(container)).toHaveLength(0);
  const catalogRows = [...container.querySelectorAll<HTMLButtonElement>('.lab-session-row')];
  expect(catalogRows).toHaveLength(2);
  expect(catalogRows[1]!.querySelector('small')?.textContent).toBe('recorded');
  await act(async () => catalogRows[1]!.click());
  expect(onOpen).toHaveBeenCalledWith(targetSummary);
});
