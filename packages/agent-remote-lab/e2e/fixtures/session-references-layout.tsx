// A source session beside a Side or a fork, as the Window shows them: the Side lists its source above its composer, the fork its copied context.
// The Host's references answer comes from the page's fetch, so no Relay is needed. `picking` opens the session picker over 14 sessions;
// `height` sets the pane's height (default 560).
import { createRoot } from 'react-dom/client';
import { SessionWorkbench } from '../../src/conversation/ConversationSurface';
import { SessionReferences } from '../../src/components/SessionReferences';
import { ForkReference } from '../../src/components/ForkReference';
import { replicaState } from '../../src/test/fixtures';
import type { SessionFork } from '../../src/session-forks';
import '../../src/session-view-styles';

const query = new URLSearchParams(window.location.search);
const kind = query.get('kind') === 'snapshot' ? 'snapshot' : 'reference';
const width = Number(query.get('width') ?? 440);
const height = Number(query.get('height') ?? 560);

const sessions = Array.from({ length: 14 }, (_, index) => ({ providerId: 'codex', nativeSessionId: `listed-${index}`, title: `Listed session ${index + 1}`, state: 'idle',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: `2026-10-01T00:${String(index).padStart(2, '0')}:00Z` }));
window.fetch = async input => new Response(JSON.stringify(new URL(String(input), location.href).pathname.endsWith('/catalog')
  ? { items: sessions, hasMore: false, revision: '1' }
  : { revision: 1, refs: kind === 'reference' ? [{ providerId: 'codex', nativeSessionId: 'source', title: 'Source session', origin: 'source' }] : [] }),
  { status: 200, headers: { 'content-type': 'application/json' } });

const fork: SessionFork = {
  id: 'fork', mode: kind === 'reference' ? 'reference' : undefined, capturedAt: '2026-10-02T00:00:00Z', delivery: 'sent', options: {}, settings: [],
  source: { agentId: 'source-agent', providerId: 'codex', nativeSessionId: 'source', title: 'Source session' },
  target: { agentId: 'side-agent', providerId: 'codex', nativeSessionId: 'side', title: 'Side session' },
  itemCount: 4, text: '[]', boundary: { epoch: 'one', seq: 4 },
} as SessionFork;

const state = { ...replicaState, agent: { ...replicaState.agent!, status: 'idle' as const, activeTurn: null } };
const actions = { sendMessage: async () => {}, sendMessageContent: async () => {}, cancel: async () => {} };

function Pane({ placement, referenced }: { placement: string; referenced: boolean }) {
  const context = referenced ? <SessionReferences scope="https://relay.example/u/layout/" holder={{ hostId: 'host', providerId: 'codex', nativeSessionId: 'side' }} providers={['codex']}
    fallback={<ForkReference fork={fork} onOpen={() => {}} />} snapshot={kind === 'snapshot' ? <ForkReference fork={fork} onOpen={() => {}} /> : undefined}
    picking={query.has('picking')} onPickingChange={() => {}} onOpen={() => {}} /> : undefined;
  return <section data-placement={placement} className={referenced ? 'lab-side-conversation' : 'lab-primary-conversation'} aria-label={placement}
    style={{ width, height, flex: 'none', minWidth: 0, padding: 0, border: 0, position: 'relative' }}>
    <SessionWorkbench state={{ ...state, agent: { ...state.agent!, id: placement } }} sessionStatus="ready" headingMode="inline" composerContext={context}
      conversationPath={<strong>{placement}</strong>} messageDraft="" onMessageDraftChange={() => {}} actions={actions} />
  </section>;
}

createRoot(document.getElementById('root')!).render(<main className="lab-shell" style={{ display: 'block', position: 'static', height: 'auto', overflow: 'visible' }}>
  <div style={{ display: 'flex', gap: 16, alignItems: 'start' }}>{query.get('only') === 'side' ? null : <Pane placement="source" referenced={false} />}<Pane placement="side" referenced /></div>
</main>);
