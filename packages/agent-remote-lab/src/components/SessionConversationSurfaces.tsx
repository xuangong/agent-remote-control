import { createContext, useCallback, useContext, useInsertionEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ContextType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { TimelineDisplayMode } from '@orchardworks/agent-remote-web/react';
import type { WorkbenchMode } from '../workbench-mode.js';
import { WorkspaceReady } from '../workspace-access.js';
import { WindowLayoutContext, WindowPresentationContext, type WindowLayoutAuthority } from '../window-workspace-context.js';
import { WindowSessionBridgeContext, type WindowSessionBridge } from '../window-session-bridge-context.js';
import { TrackViewScope } from '../hooks/useSessionAttention.js';
import { AskViewScope } from '../hooks/useAskVisibility.js';
import { TpmViewScope } from '../hooks/useTpmVisibility.js';
import { TeamViewScope } from '../hooks/useTeamVisibility.js';
import { sessionKey } from '../session-tree.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { moveSessionHost, useSessionDockHeadingStart } from './SessionDock.js';
import { SessionConversation, type SessionConversationProps } from './SessionConversation.js';
import { ToastActivity } from './Toast.js';

interface ConversationPresentation {
  visible: boolean; fixedDisplayMode?: TimelineDisplayMode; dockHeadingStart?: ReactNode;
  onPendingInputChange?(count: number): void;
}
export interface SessionSurfaceDescriptor {
  slotId: string;
  props: SessionConversationProps & ConversationPresentation;
  layout?: WindowLayoutAuthority; bridge?: WindowSessionBridge; presentedViewId?: string;
  titleInteraction: ContextType<typeof SessionTitleInteractionContext>;
  onSelectWindowPane?(): void;
  /** Keep the conversation in its destination, and attached, while its active registration is not visible. */
  retainHidden?: boolean;
}
export function allowsWindowPaneSelection(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('[data-pane-selection-ignore],.lab-conversation-history,.lab-session-heading-actions-trigger,.lab-timeline-tools-toggle,.lab-session-main-minimize');
}
export interface SessionConversationSurfacesProps {
  scope: string; transport: RemoteAgentTransport; mode: WorkbenchMode; children: ReactNode;
}
interface CapturedDescriptor extends SessionSurfaceDescriptor {
  track: ContextType<typeof TrackViewScope>; ask: ContextType<typeof AskViewScope>;
  tpm: ContextType<typeof TpmViewScope>; team: ContextType<typeof TeamViewScope>;
}
interface Registration { mode: WorkbenchMode; active: boolean; destination: HTMLElement; descriptor: CapturedDescriptor }
interface SurfaceEntry {
  slotId: string; host: HTMLDivElement; registrations: Map<symbol, Registration>;
  last: Registration; pending: number;
}
/** Transient destinations only. Group membership and live locators remain application-owned. */
class ConversationSurfaces {
  readonly entries = new Map<string, SurfaceEntry>();
  parking?: HTMLElement;
  private listeners = new Set<() => void>();
  private revision = 0;
  private generation = 0;
  private live = true;
  constructor(public mode: WorkbenchMode) {}
  selectMode(mode: WorkbenchMode) {
    if (this.mode === mode) return;
    this.mode = mode; this.publish();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private publish() { this.revision++; for (const listener of this.listeners) listener(); }
  activate() { this.live = true; this.generation++; }
  deactivate() {
    this.live = false;
    const generation = ++this.generation;
    queueMicrotask(() => {
      if (this.live || generation !== this.generation) return;
      for (const entry of this.entries.values()) entry.host.remove();
      this.entries.clear(); this.publish();
    });
  }
  register(token: symbol, registration: Registration) {
    const { slotId } = registration.descriptor;
    let entry = this.entries.get(slotId);
    if (!entry) {
      const host = document.createElement('div'); host.className = 'lab-session-conversation-host';
      // Both the destination and host fill the existing flex pane without changing its layout authority.
      Object.assign(host.style, { display: 'flex', flex: '1', flexDirection: 'column', minHeight: '0', minWidth: '0', height: '100%' });
      entry = { slotId, host, registrations: new Map(), last: registration, pending: 0 };
      this.entries.set(slotId, entry);
    }
    entry.registrations.set(token, registration); this.publish();
  }
  unregister(slotId: string, token: symbol) {
    const entry = this.entries.get(slotId);
    if (!entry?.registrations.delete(token)) return;
    this.publish(); this.collect(entry);
  }
  reportPending(entry: SurfaceEntry, count: number) {
    if (!this.live || this.entries.get(entry.slotId) !== entry) return false;
    if (entry.pending !== count) { entry.pending = count; this.publish(); }
    if (!count) this.collect(entry);
    return true;
  }
  private collect(entry: SurfaceEntry) {
    queueMicrotask(() => {
      if (!this.live || this.entries.get(entry.slotId) !== entry || entry.registrations.size || entry.pending) return;
      this.entries.delete(entry.slotId); entry.host.remove(); this.publish();
    });
  }
}
const SurfaceScope = createContext<{ registry: ConversationSurfaces } | undefined>(undefined);

export function SessionConversationSurfaces({ scope, transport, mode, children }: SessionConversationSurfacesProps) {
  const enabled = useContext(WorkspaceReady);
  const registry = useMemo(() => new ConversationSurfaces(mode), [scope, transport]);
  const context = useMemo(() => ({ registry }), [registry]);
  // A stable ref: React detaches a changed ref in the mutation phase, when the surfaces already place their hosts.
  const parkingRef = useCallback((element: HTMLDivElement | null) => { element?.setAttribute('inert', ''); registry.parking = element ?? undefined; }, [registry]);
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
  // Child layout effects publish destinations first; select their mode from that same committed registration set.
  useLayoutEffect(() => registry.selectMode(mode), [registry, mode]);
  useLayoutEffect(() => {
    registry.activate();
    return () => registry.deactivate();
  }, [registry]);
  return <SurfaceScope.Provider value={context}>{children}
    <div hidden aria-hidden="true" ref={parkingRef} />
    {[...registry.entries.values()].map(entry => <ConversationSurface key={entry.slotId} registry={registry} entry={entry} mode={registry.mode} enabled={enabled} />)}
  </SurfaceScope.Provider>;
}

function ConversationSurface({ registry, entry, mode, enabled }: { registry: ConversationSurfaces; entry: SurfaceEntry; mode: WorkbenchMode; enabled: boolean }) {
  const registrations = [...entry.registrations.values()];
  const selected = registrations.find(item => item.mode === mode && item.active);
  const chosen = selected ?? registrations.find(item => item.mode === mode) ?? registrations[0] ?? entry.last;
  const descriptor = chosen.descriptor;
  const shown = !!selected && descriptor.props.visible;
  const placed = shown || !!selected && !!descriptor.retainHidden;
  entry.last = chosen;
  // The Window still owns attachment of its selected primary view when the same slot is shown as a Bot.
  const window = chosen.mode === 'bot' ? registrations.find(item => item.mode === 'window'
    && sessionKey(item.descriptor.props.target) === sessionKey(descriptor.props.target)) : undefined;
  const attachment = window?.descriptor.props ?? descriptor.props;
  // Place the host before any layout effect of the conversation runs: those of a view that just became visible
  // measure, scroll and focus their content (a Trace reveal, a restored reading position), which a parked host cannot.
  // A layout effect here would run too late: React runs a parent's layout effects after its children's, and the
  // conversation is a child (through the portal). useInsertionEffect is used for moving DOM because it runs in the
  // commit's mutation phase: after this commit's DOM changes inside the host (children are committed first), and
  // before every layout effect and ref attachment of the commit. It relies on that order only; the destination it
  // moves to is a node from an earlier commit (registered in a layout effect, then published), and the parking element
  // may still be unset on the first commit, which is why a missing destination is skipped.
  useInsertionEffect(() => {
    const destination = placed ? chosen.destination : registry.parking;
    if (destination) moveSessionHost(entry.host, destination);
  });
  useLayoutEffect(() => {
    if (chosen.mode !== 'window' || !shown || !enabled || !descriptor.onSelectWindowPane) return;
    // The listener of a host just parked is removed only after the insertion effect moved it: ignore its events.
    const select = (event: Event) => { if (allowsWindowPaneSelection(event.target) && !entry.host.closest('[hidden], [inert]')) descriptor.onSelectWindowPane?.(); };
    entry.host.addEventListener('pointerdown', select, true);
    entry.host.addEventListener('focusin', select, true);
    return () => {
      entry.host.removeEventListener('pointerdown', select, true);
      entry.host.removeEventListener('focusin', select, true);
    };
  }, [entry.host, chosen.mode, shown, enabled, descriptor.onSelectWindowPane]);
  const props: SessionConversationProps = { ...descriptor.props,
    attachmentManaged: attachment.attachmentManaged, attachedSession: attachment.attachedSession, attachmentNotice: attachment.attachmentNotice,
    visible: shown, mutationBlocked: !enabled || !placed || descriptor.props.mutationBlocked,
    attachmentEnabled: enabled && placed && descriptor.props.attachmentEnabled !== false,
    onPendingInputChange(count) {
      if (registry.reportPending(entry, count)) descriptor.props.onPendingInputChange?.(count);
    },
  };
  return createPortal(<ToastActivity.Provider value={shown}><WindowLayoutContext.Provider value={descriptor.layout}>
    <WindowSessionBridgeContext.Provider value={descriptor.bridge}><WindowPresentationContext.Provider value={descriptor.presentedViewId}>
      <SessionTitleInteractionContext.Provider value={descriptor.titleInteraction}>
        <TrackViewScope.Provider value={descriptor.track}><AskViewScope.Provider value={descriptor.ask}>
          <TpmViewScope.Provider value={descriptor.tpm}><TeamViewScope.Provider value={descriptor.team}>
            <SessionConversation {...props} />
          </TeamViewScope.Provider></TpmViewScope.Provider>
        </AskViewScope.Provider></TrackViewScope.Provider>
      </SessionTitleInteractionContext.Provider>
    </WindowPresentationContext.Provider></WindowSessionBridgeContext.Provider>
  </WindowLayoutContext.Provider></ToastActivity.Provider>, entry.host, entry.slotId);
}

export function SessionConversationMount({ mode, descriptor, active }: { mode: WorkbenchMode; descriptor: SessionSurfaceDescriptor; active: boolean }) {
  const scope = useContext(SurfaceScope);
  const layout = useContext(WindowLayoutContext), bridge = useContext(WindowSessionBridgeContext);
  const presentedViewId = useContext(WindowPresentationContext), titleInteraction = useContext(SessionTitleInteractionContext);
  const track = useContext(TrackViewScope), ask = useContext(AskViewScope), tpm = useContext(TpmViewScope), team = useContext(TeamViewScope);
  const dockHeadingStart = useSessionDockHeadingStart();
  const destination = useRef<HTMLDivElement>(null), token = useRef(Symbol('conversation destination'));
  const captured: CapturedDescriptor = mode === 'window' ? { ...descriptor,
    layout: descriptor.layout ?? layout, bridge: descriptor.bridge ?? bridge,
    presentedViewId: descriptor.presentedViewId ?? presentedViewId, titleInteraction: descriptor.titleInteraction ?? titleInteraction,
    props: { ...descriptor.props, dockHeadingStart: descriptor.props.dockHeadingStart ?? dockHeadingStart }, track, ask, tpm, team,
  } : { ...descriptor, layout: undefined, bridge: undefined, presentedViewId: undefined, titleInteraction: undefined,
    track: undefined, ask: undefined, tpm: undefined, team: undefined,
    props: { ...descriptor.props, familyRoot: false, dockHeadingStart: undefined },
  };
  useLayoutEffect(() => {
    if (scope && destination.current) scope.registry.register(token.current, { mode, descriptor: captured, active, destination: destination.current });
  });
  useLayoutEffect(() => {
    const owner = token.current;
    return () => scope?.registry.unregister(descriptor.slotId, owner);
  }, [scope?.registry, descriptor.slotId]);
  if (!scope) return <SessionConversation {...descriptor.props} dockHeadingStart={captured.props.dockHeadingStart} visible={active && descriptor.props.visible} />;
  return <div ref={destination} className="lab-session-conversation-destination" style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0, height: '100%' }} />;
}
