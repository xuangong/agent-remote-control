import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyWindowOperation, createWindowView, type WorkspaceWindow, type WindowOperation } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import { SessionDockProvider, SessionDockRail } from '../../src/components/SessionDock';
import { SessionFamily } from '../../src/components/SessionFamily';
import { SessionWindow } from '../../src/components/SessionWindow';
import { DraftStore } from '../../src/draft-store';
import { WindowLayoutContext, WindowPresentationContext } from '../../src/window-workspace-context';
import { WorkspaceReady } from '../../src/workspace-access';
import { replicaState } from '../../src/test/fixtures';
import '../../src/session-view-styles';
import '../../src/ask.css';

const parameters = new URLSearchParams(location.search);
const primaryOnly = parameters.has('primary-only');
const selection = parameters.has('selection');
const withContent = parameters.has('content') || selection;
const withEmpty = parameters.has('empty');
const titleDrag = parameters.has('title-drag');
const presentationFallback = parameters.has('presentation-fallback');
const storageKey = `session-family-resize-window${primaryOnly ? '-primary' : ''}${selection ? '-selection' : ''}${titleDrag ? '-title-drag' : ''}`;
const target = (id: string, title: string) => ({ hostId: 'fixture', providerId: 'recorded', nativeSessionId: id, title });
function initialWindow(): WorkspaceWindow {
  const primary = { ...createWindowView('primary', target('primary', 'Primary'), 'primary'), width: primaryOnly ? 1600 : 440 };
  const dock = { ...createWindowView('dock', target('dock', 'Dock'), 'dock'), width: 440 };
  const children = (root: typeof primary) => [
    { ...createWindowView(`${root.id}-child`, target(`${root.id}-child`, `${root.binding!.title} child`), 'attached'), attachedTo: root.id, width: 320 },
    { ...createWindowView(`${root.id}-leaf`, target(`${root.id}-leaf`, `${root.binding!.title} leaf`), 'attached'), attachedTo: `${root.id}-child`, width: 320 },
  ];
  const workspace: WorkspaceWindow = { schemaVersion: 3, id: 'resize-window', title: 'Resize window', revision: 0,
    selectedPrimaryViewId: primary.id, selectedViewId: primary.id,
    views: titleDrag ? [{ ...primary, width: 240 }, { ...dock, width: 320 }, ...children(dock).map(view => ({ ...view, width: 240 })),
      { ...createWindowView('peer', target('peer', 'Peer'), 'dock'), width: 320 }, { ...createWindowView('empty', undefined, 'dock'), width: 280 }]
      : [primary, ...children(primary), ...(primaryOnly ? [] : [dock, ...children(dock)]), ...(withEmpty ? [createWindowView('empty', undefined, 'dock')] : [])] };
  const selected = presentationFallback ? 'dock-child' : parameters.get('selected');
  return selected ? applyWindowOperation(workspace, { type: 'view.select', viewId: selected }) : workspace;
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
const globalControls = <span data-pane-selection-ignore>
  <button type="button" aria-label="Global View">View</button>
  <button type="button" aria-label="Global sidebar">Sidebar</button>
</span>;
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
  const dockViews = workspace.views.filter(view => view.placement === 'dock' || view.placement === 'float');
  return <WorkspaceReady.Provider value={false}>
    <WindowLayoutContext.Provider value={{ window: workspace, readWindow: () => latest.current, operate }}>
      <WindowPresentationContext.Provider value={compact && presentationFallback ? 'primary-child' : undefined}>
      <SessionDockProvider enabled={!compact}>
        <main className="lab-shell" style={{ display: 'flex', height: '100dvh', padding: 0 }}>
          <SessionDockRail compact={compact} primaryGroups={[{
            id: primary.id, title: primary.binding!.title, width: primary.width, additionalWidth,
            selected: true, collapsed: false,
            content: <SessionFamily target={primary.binding!} viewId={primary.id} compact={compact} active offline
              storageScope="family-resize" baseUrl="http://fixture.invalid" hostLabel="Fixture"
              controls={selection && !compact ? globalControls : undefined}
              transport={transport} draftStore={drafts} onAdditionalWidthChange={setAdditionalWidth} sessionPresentation={sessionPresentation} />,
          }]}
            onSelectPrimaryGroup={viewId => operate({ type: 'view.select', viewId })}
            onResizePrimaryGroup={(viewId, width) => operate({ type: 'view.resize', viewId, width })} />
          {dockViews.map(dock => <SessionWindow key={dock.id} entry={{ id: dock.id, target: dock.binding }} baseUrl="http://fixture.invalid" visible={!compact || titleDrag && workspace.selectedViewId === dock.id}
            compact={compact} hostLabel="Fixture" offline transport={transport} draftStore={drafts}
            selected={workspace.selectedViewId === dock.id}
            sessionPresentation={sessionPresentation}
            navigation={() => ({ childrenFor: () => [], resolveSessionLink: () => undefined })}
            onFocus={() => operate({ type: 'view.select', viewId: dock.id })}
            onChangeSession={() => { document.documentElement.dataset.fixtureChangeSession = dock.id; }} onClose={() => {}} />)}
        </main>
      </SessionDockProvider>
      </WindowPresentationContext.Provider>
    </WindowLayoutContext.Provider>
  </WorkspaceReady.Provider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
