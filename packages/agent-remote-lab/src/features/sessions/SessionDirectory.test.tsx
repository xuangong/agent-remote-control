import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DirectoryError, SessionDirectoryClient, type SessionSummary } from '../../kernel/directory-client.js';
import { render } from '../../test/setup.js';
import { SessionConfiguration, SessionDirectory } from './SessionDirectory.js';

const summary = (nativeSessionId: string): SessionSummary => ({ nativeSessionId, providerId: 'recorded', title: nativeSessionId, state: 'idle', createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z' });
function button(container: HTMLElement, label: string): HTMLButtonElement { return [...container.querySelectorAll('button')].find((item) => item.textContent === label)!; }

describe('SessionDirectory', () => {
  it('marks the current discovery row and reuses navigation history without displaying it', async () => {
    const directory = new SessionDirectoryClient('http://localhost');
    vi.spyOn(directory, 'list').mockResolvedValue({items: ['current', 'opened', 'foreign-host', 'foreign-provider'].map(summary), hasMore: false, revision: '1'});
    const opened = [
      {agentId: 'current-agent', providerId: 'recorded', nativeSessionId: 'current', title: 'Current'},
      {agentId: 'opened-agent', providerId: 'recorded', nativeSessionId: 'opened', title: 'Opened'},
      {agentId: 'foreign-host-agent', hostId: 'another-host', providerId: 'recorded', nativeSessionId: 'foreign-host', title: 'Foreign host'},
      {agentId: 'foreign-provider-agent', providerId: 'another-provider', nativeSessionId: 'foreign-provider', title: 'Foreign provider'},
    ];
    const onSelect = vi.fn(); const onOpen = vi.fn();
    const container = await render(<SessionDirectory directory={directory} providerId="recorded" activeAgentId="current-agent" opened={opened} busy={false} revision={0} onOpen={onOpen} onSelect={onSelect} onClose={() => {}} />);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Discover sessions"] .lab-session-row')];
    expect(rows[0]!.textContent).toContain('Current session');
    expect(rows[0]!.getAttribute('aria-current')).toBe('page');
    expect(rows[1]!.querySelector('small')!.textContent).not.toContain('Opened');
    expect(container.querySelector('[aria-label="Opened sessions"]')).toBeNull();
    expect(rows[2]!.textContent).not.toContain('Opened');
    expect(rows[3]!.textContent).not.toContain('Opened');
    await act(async () => rows[1]!.click());
    expect(onSelect).toHaveBeenCalledWith(opened[1]);
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => rows[2]!.click());
    expect(onOpen).toHaveBeenCalledWith(summary('foreign-host'));
  });

  it('appends unique pages, keeps expired rows, and refreshes only on request', async () => {
    const directory = new SessionDirectoryClient('http://localhost');
    const list = vi.spyOn(directory, 'list').mockResolvedValueOnce({ items: [summary('first')], hasMore: true, nextCursor: 'next', revision: '1' })
      .mockRejectedValueOnce(new DirectoryError('Expired', 'cursor_expired'))
      .mockResolvedValueOnce({ items: [summary('new')], hasMore: true, nextCursor: 'more', revision: '2' })
      .mockResolvedValueOnce({ items: [summary('new'), summary('older')], hasMore: false, revision: '2' });
    const onOpen = vi.fn();
    const container = await render(<SessionDirectory directory={directory} providerId="recorded" opened={[]} busy={false} revision={0} onOpen={onOpen} onSelect={() => undefined} onClose={() => undefined} />);
    await act(async () => button(container, 'Load more sessions').click());
    expect(container.textContent).toContain('This session list expired');
    expect(container.textContent).toContain('first');
    expect(button(container, 'Load more sessions').disabled).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => button(container, 'Refresh').click());
    expect(container.querySelectorAll('.lab-session-row')).toHaveLength(1);
    await act(async () => button(container, 'Load more sessions').click());
    expect(container.querySelectorAll('.lab-session-row')).toHaveLength(2);
    await act(async () => (container.querySelector('.lab-session-row') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith(summary('new'));
  });


});

it('selects an already opened native child from discovery and preserves its closed parent in the hierarchy', async () => {
  const directory = new SessionDirectoryClient('http://localhost');
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [summary('root')], hasMore: false, revision: '1' });
  const child = { ...summary('child'), parentNativeSessionId: 'root', createdAt: '2026-09-10', status: 'running' as const };
  const opened = [{ agentId: 'child-agent', nativeSessionId: 'child', providerId: 'recorded', title: 'child', parentNativeSessionId: 'root' }];
  const onOpenRelated = vi.fn();
  const onSelect = vi.fn();
  const container = await render(<SessionDirectory directory={directory} providerId="recorded" opened={opened} known={[summary('root'), child]} activeAgentId="child-agent" busy={false} revision={0} onOpenRelated={onOpenRelated} onOpen={() => {}} onSelect={onSelect} onClose={() => {}} />);
  const discovery = container.querySelector('[aria-label="Discover sessions"]')!;
  expect(discovery.querySelector('.lab-session-tree .lab-session-tree')).toBeNull();
  expect(discovery.querySelector('[aria-expanded="false"]')).not.toBeNull();
  await act(async () => (discovery.querySelector('[aria-label="Expand root"]') as HTMLButtonElement).click());
  const nested = discovery.querySelector('.lab-session-tree .lab-session-tree .lab-session-row') as HTMLButtonElement;
  expect(nested.textContent).toContain('Working');
  await act(async () => nested.click());
  expect(onSelect).toHaveBeenCalledWith(opened[0]);
  expect(onOpenRelated).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Opened sessions"]')).toBeNull();
  await act(async () => (discovery.querySelector('[aria-label="Collapse root"]') as HTMLButtonElement).click());
  expect(discovery.querySelector('.lab-session-tree .lab-session-tree')).toBeNull();
});


it('distinguishes unknown activity from idle and keeps unknown sessions openable', async () => {
  const directory = new SessionDirectoryClient('http://localhost');
  const states = ['unknown', 'idle', 'running', 'waiting', 'unavailable'] as const;
  vi.spyOn(directory, 'list').mockResolvedValue({items: states.map(state => ({...summary(state), state})), hasMore: false, revision: '1'});
  const onOpen = vi.fn();
  const container = await render(<SessionDirectory directory={directory} providerId="recorded" opened={[]} busy={false} revision={0} onOpen={onOpen} onSelect={() => {}} onClose={() => {}} />);
  const rows = [...container.querySelectorAll<HTMLButtonElement>('.lab-session-row')];
  expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual([
    expect.stringContaining('Unknown'), expect.stringContaining('Idle'), expect.stringContaining('Working'), expect.stringContaining('Waiting'), expect.stringContaining('Unavailable'),
  ]);
  expect(rows.map(row => row.disabled)).toEqual([false, false, false, false, true]);
  await act(async () => rows[0]!.click());
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({nativeSessionId: 'unknown'}));
});

it('keeps registered workspace selection without offering folder browsing to shared users', async () => {
  const directory = new SessionDirectoryClient('http://localhost');
  vi.spyOn(directory, 'workspaces').mockResolvedValue({ workspaces: [{ id: 'project', name: 'Project', path: '/work/project' }] });
  const container = await render(<SessionConfiguration directory={directory} providerId="codex" value={{}} disabled={false} canBrowse={false} onChange={() => {}} />);
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Browse…')).toBe(false);
  const label = [...container.querySelectorAll('label')].find(label => label.textContent === 'Workspace')!;
  expect(label.control?.textContent).toContain('Project');
});

it('lists native sessions only after the explicit button and retains partial results after failure', async () => {
  const directory = new SessionDirectoryClient('http://localhost', undefined, 'host');
  const status = vi.spyOn(directory, 'listing').mockResolvedValue({ refreshing: false, complete: false, version: 0 });
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  const container = await render(<SessionDirectory listingPollMs={20} directory={directory} providerId="codex" hostId="host" opened={[]} busy={false} revision={0} onOpen={() => {}} onSelect={() => {}} onClose={() => {}} />);
  expect(status).toHaveBeenCalledWith('codex');
  expect(status.mock.calls.some(call => call[1] === true)).toBe(false);
  await act(async () => button(container, 'Refresh').click());
  expect(status.mock.calls.some(call => call[1] === true)).toBe(false);
  status.mockResolvedValueOnce({ refreshing: true, complete: false, version: 1 });
  await act(async () => button(container, 'List native sessions').click());
  expect(status).toHaveBeenLastCalledWith('codex', true);
  expect(button(container, 'Listing native sessions…').disabled).toBe(true);
  status.mockResolvedValue({ refreshing: false, complete: false, error: 'Native deadline exceeded.', version: 2 });
  vi.mocked(directory.list).mockResolvedValue({ items: [{ ...summary('saved'), providerId: 'codex' }], hasMore: false, revision: '2' });
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('Listing stopped:'); }, { timeout: 4000 });
  expect(container.textContent).toContain('Previously found sessions are still available.');
  expect(container.querySelector('.lab-session-row')?.textContent).toContain('saved');
  expect(button(container, 'List native sessions').disabled).toBe(false);
});

/** What reaches the Host's directory while the page shows it: the evidence for how soon a terminal's turn can be noticed. */
describe('the requests a mounted session directory makes', () => {
  async function counted(run: (state: { requests: string[]; clock: typeof vi }) => Promise<void>) {
    const requests: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace(/^\/v1\/remote\//, '');
      requests.push(path);
      return new Response(JSON.stringify(path === 'catalog/revision' ? { revision: '1' } : { items: [summary('one')], hasMore: false, revision: '1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const directory = new SessionDirectoryClient('http://localhost', fetcher);
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    try {
      await render(<SessionDirectory directory={directory} providerId="recorded" opened={[]} busy={false} revision={0} onOpen={() => {}} onSelect={() => {}} onClose={() => {}} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await run({ requests, clock: vi });
    } finally { visibility.mockRestore(); vi.useRealTimers(); }
  }
  const revisions = (requests: string[]) => requests.filter(path => path === 'catalog/revision').length;

  it('checks the revision once every five seconds while it is mounted and visible, and lists once on mount', async () => {
    await counted(async ({ requests }) => {
      expect(requests.filter(path => path === 'catalog')).toHaveLength(1);
      const before = revisions(requests);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(revisions(requests) - before).toBe(6);
      expect(requests.filter(path => path === 'catalog')).toHaveLength(1);
    });
  });

  it('asks nothing when the page is hidden, and nothing more than the next five-second check when it is shown again', async () => {
    await counted(async ({ requests }) => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(60_000); });
      const hidden = requests.length;
      visibility.mockReturnValue('visible');
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
      expect(requests.length).toBe(hidden);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(requests.slice(hidden).filter(path => path === 'catalog/revision')).toHaveLength(1);
      expect(requests.slice(hidden).filter(path => path === 'catalog')).toHaveLength(0);
    });
  });
});
