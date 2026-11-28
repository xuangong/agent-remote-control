// A bot workbench on its real rail and model, over builder states: the bound Window (a main tile and one tile the person added), and the
// bot's sub-sessions, which the page sets on `window.workbench` (set, selectTile) so a test can start, end and change them while it
// watches the layout. Tiles hold a field instead of a session, since the layout is under test. Windows writes are counted on `writes`.
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createWindowView, type Board, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { LocaleProvider, TaskDirectoryContext, useTranslate, type TaskDirectory } from '@orchardworks/agent-client-web/react';
import { bindLanguage } from '@orchardworks/agent-client-web/browser';
import { SessionDockProvider, SessionDockRail } from '../../src/kernel/SessionDock';
import { WindowLayoutContext } from '../../src/kernel/window-workspace-context';
import { workbenchGroup } from '../../src/features/windows/bot-workbench-binding';
import { useBotWorkbench } from '../../src/app/useBotWorkbench';
import { DerivedTileBar, workbenchPanes } from '../../src/app/views/derivedWorkbenchTiles';
import { WorkbenchPhone } from '../../src/app/views/WorkbenchPhone';
import { BotWorkbenchContext } from '../../src/features/windows/BotWorkbenchContext';
import '../../src/session-view-styles';
import './orchard-primitives.css';

const params = new URLSearchParams(location.search);
const seat = (nativeSessionId: string, role: 'leader' | 'requester' = 'leader') => ({ id: nativeSessionId, hostId: 'fixture', providerId: 'recorded', role, name: nativeSessionId, nativeSessionId, creation: 'ready' as const });
const inbox = { id: 'inbox', inbox: { botId: 'b1' }, members: [seat('main')], status: 'active' } as unknown as Team;
const sub = (n: number, state: string, step?: string) => ({ id: `s${n}`, status: 'active', source: { nativeSessionId: 'main' },
  task: { title: `Sub-session ${n}`, state, subSessionId: `s_${n}`, createdAt: n, updatedAt: n, ...(step ? { currentStep: step } : {}) }, members: [seat(`n${n}`), seat('main', 'requester')] }) as unknown as Team;
const states = ['needs_input', 'working', 'idle', 'working', 'ended'];
const initial = (count: number) => Array.from({ length: count }, (_, index) => sub(index + 1, states[index % states.length]!, index % 2 ? 'Reading the failing test' : undefined));

const item = (key: number, title: string, assignee: string) => ({ key, title, status: 'working', assignee, links: [], version: 1, changedAt: {}, updatedBy: 'person', updatedAt: 1, createdAt: 1 });
const board = { next: 3, items: [item(1, 'Fix the failing build', 's_1'), item(2, 'Write the notes', 'self')] } as unknown as Board;
const directory = { canOpen: () => false, open: () => {}, owned: () => [], act: async () => {}, boardOf: () => board, botName: (id: string) => id === 's_1' ? 'Sub-session 1' : id,
  assignees: () => [], staff: () => [{ botId: 's1', name: 'Pebbles' }] } as unknown as TaskDirectory;
const opened: string[] = [];
(window as unknown as { openedWorkbenches: string[] }).openedWorkbenches = opened;
const actions = { bots: [{ botId: 'b1', name: 'Dango' }, { botId: 's1', name: 'Pebbles' }], boundTo: () => undefined, openWorkbench: async (id: string) => { opened.push(id); }, openChat: async () => { opened.push('chat'); }, request: () => {} };
const writes: unknown[] = [];
const api = { writes, set: (_teams: Team[]) => {}, tasks: [] as Team[] };
(window as unknown as { workbench: typeof api }).workbench = api;

function Content({ title }: { title: string }) { return <div className="lab-fixture-tile" style={{ padding: 12 }}><h3>{title}</h3><textarea aria-label={`Draft for ${title}`} /></div>; }

function Fixture() {
  const t = useTranslate();
  const [teams, setTeams] = useState<Team[]>(() => [inbox, ...initial(Number(params.get('subs') ?? 3))]);
  api.set = next => setTeams([inbox, ...next]); api.tasks = teams;
  const group = useMemo(() => {
    const base = workbenchGroup('b1', 'Dango', { hostId: 'fixture', providerId: 'recorded', nativeSessionId: 'main', title: 'Dango' }, 'wb');
    return { ...base.window, views: [...base.window.views, createWindowView('note', { hostId: 'fixture', providerId: 'recorded', nativeSessionId: 'note', title: 'My notes' }, 'primary')] } as WorkspaceWindow;
  }, []);
  const workbench = useBotWorkbench({ baseUrl: 'http://fixture.invalid', sharedWindow: group, teamRoster: { baseUrl: 'http://fixture.invalid', teams: [], tasks: teams },
    windowWorkspace: { authority: { operate: (operation: unknown) => { writes.push(operation); } } } } as never);
  const stored = group.views.map(view => ({ id: view.id, title: view.binding!.title, width: view.width, collapsed: view.collapsed, selected: !workbench.selected && view.id === group.selectedPrimaryViewId,
    content: <Content title={view.binding!.title} /> }));
  const derived = workbenchPanes(workbench, tile => <div className="lab-derived-tile"><DerivedTileBar tile={tile} t={t} onKeep={() => workbench.keep(tile)} /><Content title={tile.title} /></div>, t);
  const panes = [...stored, ...derived];
  return <BotWorkbenchContext.Provider value={actions}><TaskDirectoryContext.Provider value={directory}>
    <WindowLayoutContext.Provider value={{ window: group, readWindow: () => group, operate: operation => { writes.push(operation); } }}>
    <SessionDockProvider enabled>
      <main className="lab-shell" style={{ display: 'flex', height: '100dvh', padding: 0 }}>
        {params.has('phone') ? <WorkbenchPhone workbench={workbench} panes={panes} openStored={() => {}} />
          : <SessionDockRail compact={false} primaryGroups={panes}
            onSelectPrimaryGroup={id => workbench.owns(id) ? workbench.select(id) : workbench.clearSelection()}
            onCollapsePrimaryGroup={(id, collapsed) => { if (workbench.owns(id)) workbench.setFolded(id, collapsed); }} />}
      </main>
    </SessionDockProvider>
  </WindowLayoutContext.Provider></TaskDirectoryContext.Provider></BotWorkbenchContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><LocaleProvider language={bindLanguage(document, localStorage, window)}><Fixture /></LocaleProvider></StrictMode>);
