import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import type { FamilySessionPresentationContext } from '../conversation/SessionFamily.js';
import type { SessionViewContext, SessionViewSource } from '../conversation/session-view-contribution.js';
import type { RemoteHost } from '../kernel/remote-host.js';
import { replicaState } from './fixtures.js';
import { buildOpened } from './render-hook.js';

type ContextFacts = Partial<Omit<SessionViewContext, 'context' | 'source'>> & {
  context?: Partial<FamilySessionPresentationContext>;
  source?: Partial<SessionViewSource>;
};

/** A Host that is online and owned, with the provider of the default session. */
export function buildHost(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return { id: 'local', name: 'Mac', online: true, providers: [{ providerId: 'codex', displayName: 'Codex' }], ...overrides };
}

/** The facts about one view of a Window, as the hook derives them; a test sets the few it reads. */
export function buildSessionViewContext(facts: ContextFacts = {}): SessionViewContext {
  const { context, source: sourceFacts, ...rest } = facts;
  const source = { ...buildOpened('s1'), hostId: 'local', viewId: 'view-s1', ...sourceFacts } as SessionViewSource;
  return {
    context: {
      session: source, viewId: source.viewId, windowViewId: source.viewId, state: replicaState, actions: {}, offline: false, pending: false, status: 'ready',
      operationBinding: { historical: false }, sessionState: { readOnly: false }, ...context,
    } as unknown as FamilySessionPresentationContext,
    options: {}, team: false, botPresentation: false, source, view: undefined, windowBot: false, isPrimary: false, fork: undefined, sourceForks: [],
    host: buildHost(), available: true, quoteView: undefined, openBot: undefined, provisional: false, assertCurrent: () => {},
    ...rest,
  };
}

/** The elements of a rendered node, fragments flattened, for a test that checks what a contribution puts where. */
export function elementsOf(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return typeof node.type === 'symbol' ? elementsOf(props.children) : [node];
}

/** The first element of a rendered node; the test fails when there is none. */
export function firstElement(node: ReactNode): ReactElement<any> {
  const [first] = elementsOf(node);
  if (!first) throw new Error('The node holds no element');
  return first;
}
