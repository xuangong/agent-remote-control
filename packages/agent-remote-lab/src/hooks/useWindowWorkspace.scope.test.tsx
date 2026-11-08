import { act, useMemo, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import type { WindowGroup } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument } from '../session-composition.js';
import { botGroup, until } from '../test/bot-mode-fixtures.js';
import { render } from '../test/setup.js';
import { useWindowWorkspace } from './useWindowWorkspace.js';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

it.each(['empty', 'delayed', 'failed', 'overlap'] as const)('publishes only the current scope catalog through a %s response', async outcome => {
  const first = botGroup('PRIVATE'), next = botGroup('PRIVATE'); next.window.title = 'Public replacement';
  let currentScope = 'https://first-scope/';
  let finish!: (groups: WindowGroup[]) => void, fail!: (error: Error) => void;
  const held = new Promise<WindowGroup[]>((resolve, reject) => { finish = resolve; fail = reject; });
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockImplementation(() => {
    return currentScope.includes('first-scope') ? Promise.resolve([first]) : outcome === 'empty' ? Promise.resolve([]) : held;
  });
  history.replaceState(null, '', '/?mode=bot');
  let change!: (scope: string) => void, setAccess!: (value: boolean) => void, workspace!: ReturnType<typeof useWindowWorkspace>;
  const renders: Array<{ scope: string; titles: string[] }> = [];
  function Harness() {
    const [scope, setScope] = useState('https://first-scope/'), [enabled, setEnabled] = useState(true);
    change = setScope; setAccess = setEnabled;
    const composition = useMemo(() => createCompositionDocument(scope), [scope]);
    workspace = useWindowWorkspace(scope, true, enabled, composition, true, { mode: 'bot', onSectionRoute() {} });
    renders.push({ scope, titles: workspace.groups.map(group => group.window.title) });
    return null;
  }
  await render(<Harness />);
  await until(() => expect(workspace.groups.map(group => group.window.title)).toEqual(['PRIVATE']));
  await act(async () => setAccess(false)); expect(workspace.groups).toEqual([first]);
  await act(async () => setAccess(true));
  await act(async () => { currentScope = 'https://next-scope/'; change(currentScope); });
  expect(renders.filter(render => render.scope === 'https://next-scope/').every(render => render.titles.length === 0)).toBe(true);
  expect(workspace.readGroup('PRIVATE')).toBeUndefined(); expect(workspace.groups).toEqual([]);
  if (outcome === 'failed') await act(async () => fail(new Error('Catalog unavailable')));
  else if (outcome !== 'empty') await act(async () => finish(outcome === 'overlap' ? [next] : []));
  if (outcome === 'overlap') await until(() => expect(workspace.groups.map(group => group.window.title)).toEqual(['Public replacement']));
  else expect(workspace.groups).toEqual([]);
  expect(workspace.groups.some(group => group === first)).toBe(false);
});

it('rejects a late catalog refresh from the departed scope even when IDs overlap', async () => {
  const first = botGroup('PRIVATE'), next = botGroup('PRIVATE'); next.window.title = 'Current catalog';
  let currentScope = 'https://first-scope/';
  let delayed = false, finish!: (groups: WindowGroup[]) => void;
  vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockImplementation(() => {
    if (!currentScope.includes('first-scope')) return Promise.resolve([next]);
    return delayed ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([first]);
  });
  history.replaceState(null, '', '/?mode=bot');
  let change!: (scope: string) => void, workspace!: ReturnType<typeof useWindowWorkspace>;
  function Harness() {
    const [scope, setScope] = useState('https://first-scope/'); change = setScope;
    const composition = useMemo(() => createCompositionDocument(scope), [scope]);
    workspace = useWindowWorkspace(scope, true, true, composition, true, { mode: 'bot', onSectionRoute() {} });
    return null;
  }
  await render(<Harness />); await until(() => expect(workspace.groups).toEqual([first]));
  delayed = true; const pending = workspace.refreshGroups();
  await act(async () => { currentScope = 'https://next-scope/'; change(currentScope); });
  await until(() => expect(workspace.groups.map(group => group.window.title)).toEqual(['Current catalog']));
  await act(async () => { finish([first]); await pending; });
  expect(workspace.groups.map(group => group.window.title)).toEqual(['Current catalog']);
});
