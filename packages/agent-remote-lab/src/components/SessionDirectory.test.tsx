import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DirectoryError, SessionDirectoryClient, type SessionSummary } from '../directory-client.js';
import { render } from '../test/setup.js';
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
  expect(container.querySelector('#session-workspace')?.textContent).toContain('Project');
});
