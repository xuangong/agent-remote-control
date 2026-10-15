import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web';
import { ConversationConnections, ConversationConnectionScope } from '../../src/conversation-connections.js';
import { SessionDirectoryClient, type OpenedSession } from '../../src/directory-client.js';
import { DraftStore } from '../../src/draft-store.js';
import { ForkStore, type SessionFork } from '../../src/session-forks.js';
import { SessionViewOperationsContext } from '../../src/session-view-operations.js';
import { labSessionSuccessionDirectory } from '../../src/session-succession-directory.js';
import { SideConversation } from '../../src/components/SideConversation.js';
import { AskConversation } from '../../src/components/AskConversation.js';
import { SessionFamily } from '../../src/components/SessionFamily.js';
import { SessionWindow } from '../../src/components/SessionWindow.js';
import { TpmWorkspace } from '../../src/components/TpmWorkspace.js';
import { askParticipantKey } from '../../src/hooks/useAskConversations.js';
import type { TpmItem } from '../../src/hooks/useTpmWork.js';
import { sessionViewNavigation } from '../../src/session-view-navigation.js';
import '../../src/session-view-styles.js';

const scope = location.origin, directory = new SessionDirectoryClient(scope);
const transport = new HttpWebSocketTransport(scope, { sessionSuccessions: true });
const params = new URLSearchParams(location.search), kind = params.get('placement')!;
const source = JSON.parse(params.get('source')!) as OpenedSession;
const main = JSON.parse(params.get('main')!) as OpenedSession;
const compact = matchMedia('(max-width: 600px)').matches;
const drafts = new DraftStore(scope), binding = { store: drafts, key: 'prompt-owner' };
const images = { scope, key: `${scope}:prompt-images` };
const noop = () => {};
function Fixture() {
  const connections = useMemo(() => new ConversationConnections(transport), []);
  const [current, setCurrent] = useState(source.nativeSessionId);
  const trigger = useRef<HTMLButtonElement>(null);
  const record: SessionFork = { id: 'ask', mode: 'reference', source: main, target: source, capturedAt: 'now', delivery: 'sent', configured: true, options: {}, settings: [] };
  const item: TpmItem = { key: 'work', hostId: 'local', hostName: 'Local', online: true, unread: false, work: { id: 'work', revision: 1, title: 'TPM', providerId: source.providerId, mainNativeSessionId: main.nativeSessionId, tpmNativeSessionId: source.nativeSessionId, phase: 'implementing', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: 'now', updatedAt: 'now', nextCheckAt: 0, outbox: [] } };
  return <SessionViewOperationsContext.Provider value={{ storageScope: scope, transport, enabled: true,
    resolveTarget: target => ({ target: { ...target, nativeSessionId: current } }), directory: () => labSessionSuccessionDirectory(directory),
    refreshSettled: async result => {
      if (result.record.phase !== 'committed') return;
      const replay = await transport.fetchSessionSuccessionOperation(result.role.id, result.record.operationId);
      const latest = await transport.fetchSessionSuccessionCurrent(result.role.id);
      if (replay.projection.receipt.phase !== 'committed' || replay.to.nativeSessionId !== latest.locator.nativeSessionId) throw new Error('The committed role is not current.');
      setCurrent(latest.locator.nativeSessionId);
    } }}><ConversationConnectionScope.Provider value={connections}>
    <output data-testid="unrelated-main">{main.nativeSessionId}</output>
    {kind === 'side' ? <SideConversation session={source} transport={transport} store={new ForkStore(scope)} draftBinding={binding} imageDraftBinding={images}
      onClose={noop} onOpenSource={noop} onOpenFork={noop} onFork={async () => ({})} />
    : kind === 'ask' ? <AskConversation entry={{ source: main, record, attached: true, attachedParticipant: askParticipantKey(record) }} transport={transport} draftBinding={binding} imageDraftBinding={images} triggerRef={trigger} storageScope={scope}
      onClose={noop} onToggleEnabled={noop} onClean={noop} onRetry={noop} onSendInput={noop} onDiscardInput={noop} />
    : kind === 'tpm' ? <TpmWorkspace session={source} item={item} visible storageScope={scope} triggerRef={trigger} transport={transport} draftBinding={binding}
      onClose={noop} onShowList={noop} onOpenMain={noop} onAction={async () => {}} onResolve={async () => {}} onRetry={noop} />
    : compact ? <SessionFamily target={source as OpenedSession & { hostId: string }} viewId="member" nativePrefixOnly storageScope={scope} baseUrl={scope} hostLabel="Local" compact active offline={false} transport={transport} draftStore={drafts} draftBinding={binding} imageDraftBinding={images} />
    : <SessionWindow entry={{ id: 'member', slotId: 'member', managed: true, target: source as OpenedSession & { hostId: string } }} baseUrl={scope} visible compact={false} hostLabel="Local" offline={false} transport={transport} draftStore={drafts} draftBinding={binding} imageDraftBinding={images}
      navigation={(session, state) => sessionViewNavigation({ source: session, state, entries: [] })} onFocus={noop} onClose={noop} />}
  </ConversationConnectionScope.Provider></SessionViewOperationsContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
