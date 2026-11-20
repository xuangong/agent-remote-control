// Bot mode's real layout on builder states: three assistants of one group, with Chief's conversation of every kind. The
// workspace applies group operations in memory, the navigation is the Workbench's own (the URL's mode, section and bot).
import { useRef, useState, type ReactNode } from 'react';
import { applyGroupOperation, createWindowView, type WindowGroup, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { translator } from '@orchardworks/agent-client';
import { browserLocale } from '@orchardworks/agent-client-web/react';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import { BotWorkspace, type BotWorkspaceProps } from '../../src/components/BotWorkspace.js';
import { useWorkbenchMode } from '../../src/hooks/useWorkbenchMode.js';
import { projectBotRoster } from '../../src/bot-roster.js';
import type { SessionActivityStatus } from '../../src/session-activity-status.js';
import type { SessionSurfaceDescriptor } from '../../src/components/SessionConversationSurfaces.js';
import type { AssistantRef } from '../../src/components/assistant/AssistantDetails.js';
import { AssistantNamesContext } from '../../src/components/assistant/names-context.js';
import { accountNames } from '../../src/assistant-names.js';

const binding = (id: string, title: string) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId: `${id}-session`, title });
/** The sample data in the reader's language: a Chinese fixture shows Chinese sample data, an English one English. */
export const SAMPLE = browserLocale() === 'zh'
  ? { names: ['团团', '软糖', '石子'], group: '笔记', ask: '为什么慢了？', reply: '看完啦，有 3 点想法', earlier: '之前的笔记', oldest: '最早的笔记', current: '整理 IM 原则',
    subagent: '看看 notes 文件夹', helper: (index: number) => `助手 ${index}`, label: '测试' }
  : { names: ['Chief', 'Builder', 'Reviewer'], group: 'Notes', ask: 'Why the delay?', reply: 'Done reading, I have 3 thoughts', earlier: 'Earlier notes', oldest: 'Oldest notes',
    current: 'Chief', subagent: 'Explore the notes folder', helper: (index: number) => `Helper ${index}`, label: 'Tester' };
export const ASSISTANTS = [
  { id: 'chief', title: SAMPLE.names[0]!, picture: { shape: 'triangle', color: '#ff8a3d', gaze: 1 }, activity: 'waiting' },
  { id: 'builder', title: SAMPLE.names[1]!, picture: { shape: 'circle', color: '#3d8bff', gaze: 2 }, activity: 'running' },
  { id: 'reviewer', title: SAMPLE.names[2]!, picture: { shape: 'sideways', color: '#8b6cff', gaze: 3 }, activity: 'idle', reply: SAMPLE.reply },
] as const;
// ?assistants=N adds quiet assistants after the three, for a list that scrolls.
const extra = Math.max(0, Number(new URLSearchParams(location.search).get('assistants') ?? 0) - ASSISTANTS.length);
// ?longName=1 gives Chief a long name, as a bot whose session is titled by its first prompt has.
const chiefName = new URLSearchParams(location.search).has('longName') ? 'Reply with the words LOCAL and OK joined by a hyphen, and nothing else' : SAMPLE.names[0]!;
const quiet = Array.from({ length: extra }, (_, index) => ({ id: `helper-${index + 1}`, title: SAMPLE.helper(index + 1) }));
// Chief is pinned and has an Ask; Builder carries a label; Reviewer is Chief's Side, so its row shows the role tag.
const views = [...ASSISTANTS, ...quiet].map(item => item.id === 'reviewer' ? { ...createWindowView(item.id, binding(item.id, item.title), 'attached'), attachedTo: 'chief' }
  : createWindowView(item.id, binding(item.id, item.id === 'chief' ? chiefName : item.title), 'primary'));
views.push({ ...createWindowView('chief-ask', { ...binding('chief-ask', SAMPLE.ask) }, 'float'), bindingPolicy: 'managed', closeWith: 'chief', feature: { kind: 'ask', id: 'ask-1' } });
const initialGroup: WindowGroup = {
  window: { schemaVersion: 3, id: 'notes', revision: 0, title: SAMPLE.group, selectedPrimaryViewId: 'chief', selectedViewId: 'chief', views },
  // Each assistant has its own name, stored with its details as a bot's first edit stores it.
  bots: { rank: 'm', members: { ...Object.fromEntries(quiet.map(item => [item.id, { name: item.title }])), ...Object.fromEntries(ASSISTANTS.map(item => [item.id, { name: item.title, picture: item.picture }])),
    chief: { name: chiefName, picture: ASSISTANTS[0].picture, pinned: true }, builder: { name: ASSISTANTS[1].title, picture: ASSISTANTS[1].picture, label: SAMPLE.label } } },
};
const sessionOf = (id: string, title: string) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId: id, title });
/** Chief's handoff chain (?history=1 shows the earlier session, with Return to current) and its subagents. */
const chain = (history: boolean) => ({ roleKey: 'chief', history, session: history ? sessionOf('chief-earlier', SAMPLE.earlier) : sessionOf('chief-session', SAMPLE.current),
  current: sessionOf('chief-session', SAMPLE.current), ...(history ? { ancestors: [sessionOf('chief-oldest', SAMPLE.oldest)] } : { predecessor: sessionOf('chief-earlier', SAMPLE.earlier), ancestors: [sessionOf('chief-oldest', SAMPLE.oldest)] }) });

/** Bot mode with the assistants of `initialGroup`; `conversation` renders the conversation of the assistant shown. */
export function BotFixture({ conversation }: { conversation(props: { assistant: { name: string; avatar: ReactNode }; visible: boolean; headingMode: 'assistant';
  details: Partial<AssistantRef>; childrenFor(): readonly { nativeSessionId: string; title: string }[] }): ReactNode }) {
  const [groups, setGroups] = useState<WindowGroup[]>([initialGroup]);
  const latest = useRef(groups); latest.current = groups;
  const navigation = useWorkbenchMode('fixture');
  const readGroup = (id: string) => latest.current.find(group => group.window.id === id);
  const workspace = {
    groups, readGroup, sectionCreationState: { state: 'idle' }, retrySection: async () => undefined,
    operateGroup: async (id: string, operation: WindowGroupOperation) => {
      const next = latest.current.map(group => group.window.id === id ? applyGroupOperation(group, operation) : group);
      latest.current = next; setGroups(next);
    },
  } as unknown as BotWorkspaceProps['workspace'];
  const t = translator(browserLocale());
  const roster = projectBotRoster(groups, [], {
    status: session => (ASSISTANTS.find(item => `${item.id}-session` === session.nativeSessionId)?.activity ?? 'unknown') as SessionActivityStatus,
    reply: session => { const reply = ASSISTANTS.find(item => `${item.id}-session` === session.nativeSessionId && 'reply' in item); return reply && 'reply' in reply ? { replyAt: Date.now() - 120_000, preview: reply.reply } : undefined; },
    unread: () => true, host: () => ({ online: true, name: 'Mac mini' }), t,
  });
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
    const assistant = ASSISTANTS.find(item => item.id === descriptor.slotId) ?? { ...ASSISTANTS[2], id: descriptor.slotId, title: descriptor.slotId };
    const picture = readGroup('notes')?.bots?.members[assistant.id]?.picture;
    const history = new URLSearchParams(location.search).get('history') === '1';
    return <>{conversation({ visible: descriptor.props.visible !== false, headingMode: 'assistant',
      details: { id: assistant.id, name: assistant.title, ...(picture ? { picture } : {}),
        ...(assistant.id === 'chief' ? { sessions: { chain: { navigation: chain(history), open: async () => true } } } : {}) },
      childrenFor: () => assistant.id === 'chief' ? [{ nativeSessionId: 'chief-explore', title: SAMPLE.subagent }] : [],
      assistant: { name: assistant.title, avatar: <AssistantAvatar id={assistant.id} {...(picture ? { picture } : {})} size={26} mood={assistant.activity === 'running' ? 'working' : 'idle'} /> } })}</>;
  };
  return <AssistantNamesContext.Provider value={accountNames(groups, t)}><div className="lab-shell fixture-assistant" style={{ display: 'block', height: '100dvh' }}>
    <BotWorkspace visible compact={matchMedia('(max-width: 1180px)').matches} scope="fixture" workspace={workspace} navigation={navigation} selected={selected} roster={roster}
      directory={{ sessions: [], sources: [], refresh: async () => {}, loadMore: async () => {} }} describeConversation={describeConversation} mount={mount}
      onSearch={() => {}} onNewBot={() => {}} hostName={() => 'Mac mini'}
      botInfo={() => ({ host: 'Mac mini', online: true, provider: 'Claude Code', earlier: ['Codex'] })} />
  </div></AssistantNamesContext.Provider>;
}
