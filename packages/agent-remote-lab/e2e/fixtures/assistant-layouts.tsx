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

const binding = (id: string, title: string) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId: `${id}-session`, title });
export const ASSISTANTS = [
  { id: 'chief', title: 'Chief', picture: { shape: 'triangle', color: '#ff8a3d', gaze: 1 }, activity: 'waiting' },
  { id: 'builder', title: 'Builder', picture: { shape: 'circle', color: '#3d8bff', gaze: 2 }, activity: 'running' },
  { id: 'reviewer', title: 'Reviewer', picture: { shape: 'sideways', color: '#8b6cff', gaze: 3 }, activity: 'idle', reply: 'Done reading, I have 3 thoughts' },
] as const;
const initialGroup: WindowGroup = {
  window: { schemaVersion: 3, id: 'notes', revision: 0, title: 'Notes', selectedPrimaryViewId: 'chief', selectedViewId: 'chief',
    views: ASSISTANTS.map(item => createWindowView(item.id, binding(item.id, item.title), 'primary')) },
  bots: { rank: 'm', members: Object.fromEntries(ASSISTANTS.map(item => [item.id, { picture: item.picture }])) },
};

/** Bot mode with the assistants of `initialGroup`; `conversation` renders the conversation of the assistant shown. */
export function BotFixture({ conversation }: { conversation(props: { assistant: { name: string; avatar: ReactNode }; visible: boolean; headingMode: 'assistant' }): ReactNode }) {
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
    const assistant = ASSISTANTS.find(item => item.id === descriptor.slotId)!;
    const picture = readGroup('notes')?.bots?.members[assistant.id]?.picture;
    return <>{conversation({ visible: descriptor.props.visible !== false, headingMode: 'assistant',
      assistant: { name: assistant.title, avatar: <AssistantAvatar id={assistant.id} {...(picture ? { picture } : {})} size={26} mood={assistant.activity === 'running' ? 'working' : 'idle'} /> } })}</>;
  };
  return <div className="lab-shell fixture-assistant" style={{ display: 'block', height: '100dvh' }}>
    <BotWorkspace visible compact={matchMedia('(max-width: 1180px)').matches} scope="fixture" workspace={workspace} navigation={navigation} selected={selected} roster={roster}
      directory={{ sessions: [], sources: [], refresh: async () => {}, loadMore: async () => {} }} describeConversation={describeConversation} mount={mount}
      rosterCollapsed={false} onToggleRoster={() => {}} onSearch={() => {}} onNewBot={() => {}} hostName={() => 'Mac mini'}
      botInfo={() => ({ host: 'Mac mini', online: true, provider: 'Claude Code', earlier: ['Codex'] })} />
  </div>;
}
