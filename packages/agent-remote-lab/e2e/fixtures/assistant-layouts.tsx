// Bot mode's real layout on builder states: three assistants of one group, with Chief's conversation of every kind. The
// workspace applies group operations in memory, the navigation is the Workbench's own (the URL's mode, section and bot).
import { useRef, useState, type ReactNode } from 'react';
import { applyGroupOperation, createWindowView, type WindowGroup, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { applyMoveSteps, type MoveStep } from '../../src/kernel/assistant-groups.js';
import { appendedRank } from '../../src/kernel/bot-roster.js';
import { translator } from '@orchardworks/agent-client';
import { browserLocale } from '@orchardworks/agent-client-web/react';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import { BotWorkspace, type BotWorkspaceProps } from '../../src/features/chats/BotWorkspace.js';
import { useWorkbenchMode } from '../../src/kernel/useWorkbenchMode.js';
import { projectBotRoster } from '../../src/kernel/bot-roster.js';
import type { SessionActivityStatus } from '../../src/kernel/session-activity-status.js';
import type { SessionSurfaceDescriptor } from '../../src/conversation/SessionConversationSurfaces.js';
import type { AssistantRef } from '../../src/conversation/assistant/AssistantDetails.js';
import { AssistantNamesContext } from '../../src/kernel/names-context.js';
import { accountNames } from '../../src/kernel/assistant-names.js';
import { HttpPreviewClient } from '@orchardworks/agent-client';
import { NavigationRail } from '../../src/shell/NavigationRail.js';
import { TabBar } from '../../src/shell/TabBar.js';
import { AssistantDirectory } from '../../src/features/chats/AssistantDirectory.js';
import { SettingsPage, type SettingsContext } from '../../src/features/settings/SettingsPage.js';
import { usePhoneLayout } from '../../src/kernel/usePhoneLayout.js';
import type { RemoteHost } from '../../src/kernel/remote-host.js';
import { DesktopFrame, useDetailsBeside } from '../../src/shell/DesktopFrame.js';
import { shownAssistantName } from '../../src/kernel/window-title.js';

const binding = (id: string, title: string) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId: `${id}-session`, title });
/** The sample data in the reader's language: a Chinese fixture shows Chinese sample data, an English one English. */
export const SAMPLE = browserLocale() === 'zh'
  ? { names: ['团团', '软糖', '石子'], group: '笔记', ask: '为什么慢了？', reply: '看完啦，有 3 点想法', earlier: '之前的笔记', oldest: '最早的笔记', current: '整理 IM 原则',
    subagent: '看看 notes 文件夹', helper: (index: number) => `助手 ${index}`, label: '测试',
    research: '研究', researchers: ['小探', '量尺'], own: [['墨点', '起草发布说明'], ['米粒', '检查周报']] as const }
  : { names: ['Chief', 'Builder', 'Reviewer'], group: 'Notes', ask: 'Why the delay?', reply: 'Done reading, I have 3 thoughts', earlier: 'Earlier notes', oldest: 'Oldest notes',
    current: 'Chief', subagent: 'Explore the notes folder', helper: (index: number) => `Helper ${index}`, label: 'Tester',
    research: 'Research', researchers: ['Scout', 'Gauge'], own: [['Ink', 'Draft the release notes'], ['Rice', 'Check the weekly report']] as const };
export const ASSISTANTS = [
  { id: 'chief', title: SAMPLE.names[0]!, picture: { shape: 'triangle', color: '#ff8a3d', gaze: 1 }, activity: 'waiting' },
  { id: 'builder', title: SAMPLE.names[1]!, picture: { shape: 'circle', color: '#3d8bff', gaze: 2 }, activity: 'running' },
  { id: 'reviewer', title: SAMPLE.names[2]!, picture: { shape: 'sideways', color: '#8b6cff', gaze: 3 }, activity: 'idle', reply: SAMPLE.reply },
] as const;
// ?assistants=N adds quiet assistants after the three, for a list that scrolls.
const extra = Math.max(0, Number(new URLSearchParams(location.search).get('assistants') ?? 0) - ASSISTANTS.length);
// ?longName=1 gives Chief a long name, as a bot whose session is titled by its first prompt has.
// ?longName=1 also titles Chief's session with its first prompt, as a real session often is.
const longName = new URLSearchParams(location.search).has('longName');
const LONG = 'Reply with the words LOCAL and OK joined by a hyphen, and nothing else';
const chiefName = longName ? LONG : SAMPLE.names[0]!;
const currentTitle = longName ? LONG : SAMPLE.current;
const quiet = Array.from({ length: extra }, (_, index) => ({ id: `helper-${index + 1}`, title: SAMPLE.helper(index + 1) }));
// Chief is pinned and has an Ask; Builder carries a label; Reviewer is Chief's Side, so its row shows the role tag.
// A Side follows the view it is attached to, as a Window keeps it, so the group stays valid for the group operations.
const views = [ASSISTANTS[0], ASSISTANTS[2], ASSISTANTS[1], ...quiet].map(item => item.id === 'reviewer' ? { ...createWindowView(item.id, binding(item.id, item.title), 'attached'), attachedTo: 'chief' }
  : createWindowView(item.id, binding(item.id, item.id === 'chief' ? chiefName : item.title), 'primary'));
views.push({ ...createWindowView('chief-ask', { ...binding('chief-ask', SAMPLE.ask) }, 'float'), bindingPolicy: 'managed', closeWith: 'chief', feature: { kind: 'ask', id: 'ask-1' } });
const initialGroup: WindowGroup = {
  window: { schemaVersion: 3, id: 'notes', revision: 0, title: SAMPLE.group, selectedPrimaryViewId: 'chief', selectedViewId: 'chief', views },
  // Each assistant has its own name, stored with its details as a bot's first edit stores it.
  bots: { rank: 'm', members: { ...Object.fromEntries(quiet.map(item => [item.id, { name: item.title }])), ...Object.fromEntries(ASSISTANTS.map(item => [item.id, { name: item.title, picture: item.picture }])),
    chief: { name: chiefName, picture: ASSISTANTS[0].picture, pinned: true }, builder: { name: ASSISTANTS[1].title, picture: ASSISTANTS[1].picture, label: SAMPLE.label } } },
};
// ?groups=1 adds a group of two assistants and two assistants in groups of their own, which the default group holds; ?muted=1
// mutes the second group.
const withGroups = new URLSearchParams(location.search).has('groups');
const researchGroup: WindowGroup = { window: { schemaVersion: 3, id: 'research', revision: 0, title: SAMPLE.research, selectedPrimaryViewId: 'scout', selectedViewId: 'scout',
  views: SAMPLE.researchers.map((name, index) => createWindowView(['scout', 'gauge'][index]!, binding(['scout', 'gauge'][index]!, name), 'primary')) },
  bots: { rank: 't', members: { scout: { name: SAMPLE.researchers[0], picture: { shape: 'circle', color: '#2fb380', gaze: 0 } }, gauge: { name: SAMPLE.researchers[1], picture: { shape: 'squircle', color: '#e85d8a', gaze: 4 } } },
    ...(new URLSearchParams(location.search).has('muted') ? { muted: true as const } : {}) } };
/** An assistant New assistant started: a group of its own, named after its session. */
const ownGroup = ([name, title]: readonly [string, string], index: number): WindowGroup => ({ window: { schemaVersion: 3, id: `own-${index + 1}`, revision: 0, title,
  selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', binding(`own-${index + 1}`, title), 'primary')] },
  bots: { rank: 'z', members: { main: { name, picture: { shape: index ? 'triangle' : 'sideways', color: index ? '#f2b33d' : '#5b8def', gaze: index + 1 } } } } });
const initialGroups: WindowGroup[] = withGroups ? [initialGroup, researchGroup, ...SAMPLE.own.map(ownGroup)] : [initialGroup];
const sessionOf = (id: string, title: string) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId: id, title });
/** Chief's handoff chain (?history=1 shows the earlier session, with Return to current) and its subagents. */
const chain = (history: boolean) => ({ roleKey: 'chief', history, session: history ? sessionOf('chief-earlier', SAMPLE.earlier) : sessionOf('chief-session', currentTitle),
  current: sessionOf('chief-session', currentTitle), ...(history ? { ancestors: [sessionOf('chief-oldest', SAMPLE.oldest)] } : { predecessor: sessionOf('chief-earlier', SAMPLE.earlier), ancestors: [sessionOf('chief-oldest', SAMPLE.oldest)] }) });

const hosts: RemoteHost[] = [
  { id: 'mac', name: 'Mac mini', online: true, managed: true, credentialRotation: true, providers: [{ providerId: 'claude', displayName: 'Claude Code' }, { providerId: 'codex', displayName: 'Codex' }],
    controller: { version: '0.3.0', platform: 'darwin', arch: 'arm64', nodeMajor: 22 } as RemoteHost['controller'] },
  { id: 'studio', name: 'Studio', online: false, managed: true, access: 'shared', providers: [{ providerId: 'claude', displayName: 'Claude Code' }] },
];
const noService = async () => { throw new Error('This fixture has no Relay.'); };
/** What the Settings page reads in a fixture: a signed-in account, two computers and no Relay. */
const settingsContext: SettingsContext = {
  facts: { account: true, notificationsAvailable: !matchMedia('(pointer: coarse)').matches },
  account: { name: SAMPLE.names[0]!, email: 'chief@example.com', ready: true, openSecurity: () => {}, signOut: () => {} }, baseUrl: 'http://fixture/',
  notifications: { enabled: true, available: true, permission: 'granted', requestFailed: false, request: () => {}, set: () => {} },
  openTrace: () => {}, openInspector: () => {},
  computers: { hosts, loaded: true, previewClient: new HttpPreviewClient('http://fixture/'),
    tunnelService: { status: noService, start: noService, stop: noService }, openPreviewSource: () => {}, onRevoked: () => {},
    service: { hosts: async () => ({ hosts }), pair: noService, smartReading: async () => ({ providers: ['claude'] }), setSmartReading: async (_host: string, provider: string, enabled: boolean) => ({ providers: enabled ? ['claude', provider] : [] }) } },
};

/** Bot mode with the assistants of `initialGroup`, the rail (or the phone's tab bar) beside it and Settings or the directory over it; `conversation` renders the conversation of the assistant shown. */
export function BotFixture({ conversation }: { conversation(props: { assistant: { name: string; avatar: ReactNode }; visible: boolean; headingMode: 'assistant';
  details: Partial<AssistantRef>; childrenFor(): readonly { nativeSessionId: string; title: string }[] }): ReactNode }) {
  const [groups, setGroups] = useState<WindowGroup[]>(initialGroups);
  const latest = useRef(groups); latest.current = groups;
  const navigation = useWorkbenchMode('fixture');
  const readGroup = (id: string) => latest.current.find(group => group.window.id === id);
  const workspace = {
    groups, readGroup, sectionCreationState: { state: 'idle' }, retrySection: async () => undefined,
    operateGroup: async (id: string, operation: WindowGroupOperation) => {
      const next = latest.current.map(group => group.window.id === id ? applyGroupOperation(group, operation) : group);
      latest.current = next; setGroups(next);
    },
    // Group operations as the Relay applies them, in memory.
    createGroup: async (title: string) => {
      const id = `group-${latest.current.length + 1}`;
      const next = [...latest.current, { window: { schemaVersion: 3, id, revision: 0, title, selectedPrimaryViewId: null, selectedViewId: null, views: [] }, bots: { rank: appendedRank(latest.current), members: {} } } as WindowGroup];
      latest.current = next; setGroups(next); return id;
    },
    rename: async (id: string, title: string) => {
      const next = latest.current.map(group => group.window.id === id ? applyGroupOperation(group, { type: 'rename', title }) : group);
      latest.current = next; setGroups(next); return { saved: Promise.resolve() };
    },
    moveAssistant: async (steps: readonly MoveStep[]) => { const next = applyMoveSteps(latest.current, steps); latest.current = next; setGroups(next); },
    deleteGroup: async (id: string) => { const next = latest.current.filter(group => group.window.id !== id); latest.current = next; setGroups(next); },
  } as unknown as BotWorkspaceProps['workspace'];
  const t = translator(browserLocale());
  const roster = projectBotRoster(groups, [], {
    status: session => (ASSISTANTS.find(item => `${item.id}-session` === session.nativeSessionId)?.activity ?? 'unknown') as SessionActivityStatus,
    reply: session => { const reply = ASSISTANTS.find(item => `${item.id}-session` === session.nativeSessionId && 'reply' in item); return reply && 'reply' in reply ? { replyAt: Date.now() - 120_000, preview: reply.reply } : undefined; },
    unread: () => true, host: () => ({ online: true, name: 'Mac mini' }), t,
  });
  const phone = usePhoneLayout();
  const everyone = projectBotRoster(groups, [], { status: session => (ASSISTANTS.find(item => `${item.id}-session` === session.nativeSessionId)?.activity ?? 'unknown') as SessionActivityStatus, host: () => ({ online: true, name: 'Mac mini' }), t, everyone: true });
  const go = (target: Parameters<typeof navigation.open>[0]) => navigation.open(target, navigation.page ? 'replace' : 'push');
  const place = navigation.place;
  const group = place?.kind === 'bot' || place?.kind === 'section' ? readGroup(place.groupId) : undefined;
  const view = place?.kind === 'bot' ? group?.window.views.find(item => item.id === place.viewId) : undefined;
  const selected = { group, view, slot: view ? { id: view.id } : undefined, loading: false, error: undefined, retry: async () => {} } as unknown as BotWorkspaceProps['selected'];
  const describeConversation = (next: NonNullable<typeof place>): SessionSurfaceDescriptor | undefined => {
    if (next.kind !== 'bot') return;
    const target = readGroup(next.groupId)?.window.views.find(item => item.id === next.viewId)?.binding;
    return target ? { slotId: next.viewId, titleInteraction: undefined, props: { target, visible: true } } as unknown as SessionSurfaceDescriptor : undefined;
  };
  const mount: NonNullable<BotWorkspaceProps['mount']> = ({ descriptor }) => {
    // Another group's assistant (?groups=1) shows its own name and picture, from the group it is in now.
    const shownGroup = place?.kind === 'bot' ? place.groupId : 'notes';
    const stored = readGroup(shownGroup)?.bots?.members[descriptor.slotId];
    const assistant = ASSISTANTS.find(item => item.id === descriptor.slotId && shownGroup === 'notes') ?? { ...ASSISTANTS[2], id: descriptor.slotId, title: stored?.name ?? descriptor.slotId };
    const picture = stored?.picture;
    const history = new URLSearchParams(location.search).get('history') === '1';
    return <>{conversation({ visible: descriptor.props.visible !== false, headingMode: 'assistant',
      details: { id: assistant.id, name: assistant.title, ...(picture ? { picture } : {}),
        ...(assistant.id === 'chief' ? { sessions: { chain: { navigation: chain(history), open: async () => true } } } : {}) },
      childrenFor: () => assistant.id === 'chief' ? [{ nativeSessionId: 'chief-explore', title: SAMPLE.subagent }] : [],
      assistant: { name: assistant.title, avatar: <AssistantAvatar id={assistant.id} {...(picture ? { picture } : {})} size={26} mood={assistant.activity === 'running' ? 'working' : 'idle'} /> } })}</>;
  };
  const page = navigation.page;
  const names = accountNames(groups, t);
  const detailsBeside = useDetailsBeside(phone);
  // The Workbench's own frame: the panels' widths and handles, the installed app's title bar and the window's title.
  return <AssistantNamesContext.Provider value={names}><div className="lab-shell fixture-assistant" style={{ display: 'block', height: '100dvh' }}>
    <DesktopFrame surface={page ? 'page' : 'bot'} phone={phone} title={shownAssistantName(place, !phone || !navigation.rosterVisible, names)} style={{ height: '100dvh' }}>
      {phone ? <TabBar current={navigation.destination} onGo={go} /> : <NavigationRail current={navigation.destination} onGo={go} onSearch={() => {}} accountName={SAMPLE.names[0]!} />}
      <BotWorkspace visible covered={!!page} compact={!detailsBeside} scope="fixture" workspace={workspace} navigation={navigation} selected={selected} roster={roster}
        directory={{ sessions: [], sources: [], refresh: async () => {}, loadMore: async () => {} }} describeConversation={describeConversation} mount={mount}
        onNewBot={() => {}} hostName={() => 'Mac mini'}
        botInfo={() => ({ host: 'Mac mini', online: true, provider: 'Claude Code', earlier: ['Codex'] })} />
      <main className="lab-page" data-workbench-mode="page" data-page={page?.destination} hidden={!page}>
        {page?.destination === 'assistants' ? <AssistantDirectory model={everyone} workspace={workspace as unknown as Parameters<typeof AssistantDirectory>[0]['workspace']} hostName={() => 'Mac mini'} onOpen={navigation.select} onNew={() => {}} /> : null}
        {page?.destination === 'settings' ? <SettingsPage context={settingsContext} group={page.group} phone={phone}
          onGroup={next => next ? navigation.open({ destination: 'settings', group: next }, phone ? 'push' : 'replace') : navigation.closePage()} /> : null}
      </main>
    </DesktopFrame>
  </div></AssistantNamesContext.Provider>;
}
