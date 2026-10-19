import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyWindowOperation, createWindowView, type WorkspaceWindow, type WindowOperation } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import { SessionDockProvider, SessionDockRail } from '../../src/components/SessionDock';
import { SessionFamily } from '../../src/components/SessionFamily';
import { SessionWindow } from '../../src/components/SessionWindow';
import { DraftStore } from '../../src/draft-store';
import { WindowLayoutContext } from '../../src/window-workspace-context';
import { WorkspaceReady } from '../../src/workspace-access';
import { replicaState } from '../../src/test/fixtures';
import '../../src/session-view-styles';
import '../../src/ask.css';

const primaryOnly = new URLSearchParams(location.search).has('primary-only');
const withContent = new URLSearchParams(location.search).has('content');
const storageKey = `session-family-resize-window${primaryOnly ? '-primary' : ''}`;
const target = (id: string, title: string) => ({ hostId: 'fixture', providerId: 'recorded', nativeSessionId: id, title });
function initialWindow(): WorkspaceWindow {
  const primary = { ...createWindowView('primary', target('primary', 'Primary'), 'primary'), width: primaryOnly ? 1600 : 440 };
  const dock = { ...createWindowView('dock', target('dock', 'Dock'), 'dock'), width: 440 };
  const children = (root: typeof primary) => [
    { ...createWindowView(`${root.id}-child`, target(`${root.id}-child`, `${root.binding!.title} child`), 'attached'), attachedTo: root.id, width: 320 },
    { ...createWindowView(`${root.id}-leaf`, target(`${root.id}-leaf`, `${root.binding!.title} leaf`), 'attached'), attachedTo: `${root.id}-child`, width: 320 },
  ];
  return { schemaVersion: 2, id: 'resize-window', title: 'Resize window', revision: 0,
    selectedPrimaryViewId: primary.id, selectedViewId: primary.id, views: [primary, ...children(primary), ...(primaryOnly ? [] : [dock, ...children(dock)])] };
}
function restore(): WorkspaceWindow {
  try { return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') ?? initialWindow(); }
  catch { return initialWindow(); }
}
const drafts = new DraftStore('session-family-resize-fixture');
const columns = Array.from({ length: 16 }, (_, index) => `Field ${index + 1}`);
const markdown = [
  '| ' + columns.join(' | ') + ' |', '| ' + columns.map(() => '---').join(' | ') + ' |',
  '| ' + columns.map((_, index) => `Value ${index + 1}`).join(' | ') + ' |',
  '', '```text', 'An intentionally long code line: ' + 'column_value '.repeat(24), '```',
].join('\n');
const contentState: AgentReplicaState = { ...replicaState, timeline: {
  ...replicaState.timeline, hasOlder: false, nextSeq: 2, entries: [{
    providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-19T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
    item: { type: 'assistant_message', text: markdown },
  }],
} };
const sessionPresentation = withContent ? () => ({ state: contentState }) : undefined;
// Layout exercises real Session Views without opening native sessions or network connections.
const transport = {
  onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect: () => ({ close() {}, send() {} }),
} as unknown as RemoteAgentTransport;
function Fixture() {
  const [workspace, setWorkspace] = useState(restore);
  const latest = useRef(workspace); latest.current = workspace;
  const [compact, setCompact] = useState(window.innerWidth <= 1180);
  const [additionalWidth, setAdditionalWidth] = useState(0);
  useEffect(() => {
    const resize = () => setCompact(window.innerWidth <= 1180);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function operate(operation: WindowOperation) {
    const next = applyWindowOperation(latest.current, operation);
    latest.current = next;
    sessionStorage.setItem(storageKey, JSON.stringify(next));
    setWorkspace(next);
  }
  const primary = workspace.views.find(view => view.id === 'primary')!;
  const dock = workspace.views.find(view => view.id === 'dock')!;
  return <WorkspaceReady.Provider value={false}>
    <WindowLayoutContext.Provider value={{ window: workspace, readWindow: () => latest.current, operate }}>
      <SessionDockProvider enabled={!compact}>
        <main className="lab-shell" style={{ display: 'flex', height: '100dvh', padding: 0 }}>
          <SessionDockRail compact={compact} primaryGroups={[{
            id: primary.id, title: primary.binding!.title, width: primary.width, additionalWidth,
            selected: true, collapsed: false,
            content: <SessionFamily target={primary.binding!} viewId={primary.id} compact={compact} active offline
              storageScope="family-resize" baseUrl="http://fixture.invalid" hostLabel="Fixture"
              transport={transport} draftStore={drafts} onAdditionalWidthChange={setAdditionalWidth} sessionPresentation={sessionPresentation} />,
          }]}
            onSelectPrimaryGroup={viewId => operate({ type: 'view.select', viewId })}
            onResizePrimaryGroup={(viewId, width) => operate({ type: 'view.resize', viewId, width })} />
          {dock ? <SessionWindow entry={{ id: dock.id, target: dock.binding }} baseUrl="http://fixture.invalid" visible={!compact}
            compact={compact} hostLabel="Fixture" offline transport={transport} draftStore={drafts}
            sessionPresentation={sessionPresentation}
            navigation={() => ({ childrenFor: () => [], resolveSessionLink: () => undefined })}
            onFocus={() => operate({ type: 'view.select', viewId: dock.id })} onClose={() => {}} /> : null}
        </main>
      </SessionDockProvider>
    </WindowLayoutContext.Provider>
  </WorkspaceReady.Provider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
