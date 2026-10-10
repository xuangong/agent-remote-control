import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type AgentChildSession } from '@orchardworks/agent-remote-protocol';
import { AgentReplica } from '@orchardworks/agent-remote-web';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import { render, unmount } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

const child: AgentChildSession = { nativeSessionId: 'native-child', title: 'Review transport', role: 'Reviewer', createdAt: '2026-09-10T00:00:00Z', status: 'idle', observation: 'live' };
const parent = { ...replicaState.agent!, id: 'parent', providerId: 'codex', persistence: { providerId: 'codex', sessionId: 'native-parent', opaque: 'native-parent' }, capabilities: { ...replicaState.agent!.capabilities, commands: true }, runtimeInfo: { providerId: 'codex', sessionId: 'native-parent', status: 'idle' as const, childSessions: [child] } };
const snapshots = {
  parent,
  child: { ...parent, id: 'child', persistence: { providerId: 'codex', sessionId: 'native-child', opaque: 'native-child' }, runtimeInfo: { providerId: 'codex', sessionId: 'native-child', status: 'idle' as const } },
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); window.sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
async function setup(reject = false, options: { live?: boolean; deferChild?: boolean; restricted?: boolean; discover?: boolean; navigation?: boolean; nested?: boolean; images?: boolean; desktop?: boolean; letters?: boolean; rootReference?: boolean; directChild?: boolean; ask?: boolean } = {}) {
  if (options.ask) localStorage.setItem('agent-remote-ask-enabled', 'true');
  if (options.ask) vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: options.desktop ? query.includes('min-width: 1181px') : query.includes('max-width: 1180px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  let connections = 0;
  let releaseChild: (() => void) | undefined;
  const childReady = options.deferChild ? new Promise<void>((resolve) => { releaseChild = resolve; }) : Promise.resolve();
  const sibling = { ...child, nativeSessionId: 'native-sibling', title: '/root/sibling' };
  const sessionSnapshots = { ...snapshots, parent: options.navigation ? { ...parent, runtimeInfo: { ...parent.runtimeInfo, childSessions: [child, sibling] } } : parent,
    sibling: { ...snapshots.child, id: 'sibling', runtimeInfo: { ...snapshots.child.runtimeInfo, sessionId: 'native-sibling' } }, child: options.restricted ? { ...snapshots.child, capabilities: { ...snapshots.child.capabilities, sendMessage: false, cancel: false }, pendingInteractions: [{ kind: 'plan_approval' as const, requestId: 'child-plan', plan: 'Review the child plan', allowedActions: ['approve' as const] }] } : snapshots.child };
  if (options.nested) sessionSnapshots.child = { ...sessionSnapshots.child, runtimeInfo: Object.assign({}, sessionSnapshots.child.runtimeInfo, { childSessions: [{ ...child, nativeSessionId: 'native-grandchild', title: '/root/review/evidence', status: 'running' as const }] }) };
  if (options.images) sessionSnapshots.parent = { ...sessionSnapshots.parent, capabilities: { ...sessionSnapshots.parent.capabilities, imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } };
  Object.assign(sessionSnapshots, { grandchild: { ...snapshots.child, id: 'grandchild', runtimeInfo: { providerId: 'codex', sessionId: 'native-grandchild', status: 'idle' } } });
  Object.assign(sessionSnapshots, {
    ask: { ...parent, id: 'ask', persistence: { providerId: 'codex', sessionId: 'native-ask', opaque: 'native-ask' }, runtimeInfo: { providerId: 'codex', sessionId: 'native-ask', status: 'idle', childSessions: [{ ...child, nativeSessionId: 'native-ask-child', title: 'Ask reviewer' }] } },
    'ask-child': { ...snapshots.child, id: 'ask-child', runtimeInfo: { providerId: 'codex', sessionId: 'native-ask-child', status: 'idle' } },
  });
  if (options.letters) sessionSnapshots.parent = { ...sessionSnapshots.parent, runtimeInfo: { ...sessionSnapshots.parent.runtimeInfo, childSessions: [{ ...child, title: '/root/review' }] } };
  const attachments: unknown[] = [];
  const resourceReads: { agentId: string; locator: string }[] = [];
  const directoryFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ items: options.discover ? [{providerId: 'codex', nativeSessionId: 'native-parent', title: 'Discovered parent', state: 'unknown', createdAt: '2026-09-10', updatedAt: '2026-09-10'}] : [], hasMore: false, revision: '1' });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    if (options.ask && path.endsWith('/create')) return Response.json({ agentId: 'ask', nativeSessionId: 'native-ask' });
    if (path.endsWith('/attach')) {
      attachments.push({ path, body: JSON.parse(String(init?.body)) });
      if (path.endsWith('/child/attach')) await childReady;
      if (reject) return Response.json({ error: 'Child is unavailable.' }, { status: 409 });
      const nativeSessionId = JSON.parse(String(init?.body)).nativeSessionId;
      return Response.json({ agentId: nativeSessionId.replace('native-', ''), nativeSessionId });
    }
    throw new Error(`Unexpected directory path: ${path}`);
  };
  const directory = new SessionDirectoryClient('http://localhost/', directoryFetch);
  if (options.directChild) vi.stubGlobal('fetch', directoryFetch);
  const resumeAgent = vi.fn(async () => { throw new Error('Native runtime must not be recreated.'); });
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'codex', displayName: 'Codex' }],
    createAgent: async () => { throw new Error('Not used'); }, resumeAgent,
    fetchSnapshot: async (agentId) => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: sessionSnapshots[agentId as keyof typeof sessionSnapshots] }),
    fetchTimeline: async (agentId) => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'page', agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: options.ask && agentId === 'ask' ? 2 : options.letters ? (options.rootReference && agentId === 'child' ? 4 : 3) : options.navigation ? 1 : 0, nextSeq: options.ask && agentId === 'ask' ? 3 : options.letters ? (options.rootReference && agentId === 'child' ? 5 : 4) : options.navigation ? 2 : 1 }, startCursor: null, endCursor: null, entries: options.ask && agentId === 'ask' ? [activityEntry('native-ask-child'), { ...activityEntry('native-ask-child'), seqStart: 2, seqEnd: 2, item: { type: 'assistant_message', text: 'Read [the source](./ask-source.ts).' } }] : options.letters ? letterEntries(agentId, options.rootReference) : options.navigation ? [activityEntry(agentId === 'child' ? 'native-sibling' : agentId === 'sibling' ? 'native-parent' : 'native-child')] : [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect: (agentId, listener) => {
      connections++;
      queueMicrotask(() => {
        listener.onOpen();
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId, revision: 'control', access: 'control', available: false, token: 'control-token' } });
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: sessionSnapshots[agentId as keyof typeof sessionSnapshots] });
      });
      return { close() {}, send(message) {
        if (message.type === 'resource_resolve_request') {
          resourceReads.push({ agentId, locator: message.payload.locator });
          queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'resource_resolve_response', payload: {
            requestId: message.payload.requestId, agentId, binding: { locator: message.payload.locator, resourceId: 'ask-source', status: 'unavailable' },
          } }));
        }
        if (message.type === 'resource_request') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'resource_response', payload: {
          requestId: message.payload.requestId, agentId, resourceId: message.payload.resourceId, state: { status: 'unavailable', reason: 'Ask source file is unavailable in this fixture.' },
        } }));
        if (message.type === 'session_control_request') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'control-token' } }));
        if (message.type === 'timeline_subscription') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } }));
      } };
    },
    onDiagnostic: () => () => {},
    onProtocolMessage: () => () => {},
  };
  const sendMessage = vi.fn(async () => {});
  const respondToInteraction = vi.fn(async () => {});
  if (options.live) window.history.replaceState(null, '', options.directChild ? '/?host=local&agent=child&provider=codex&session=native-child&parent=native-parent' : '/?agent=parent');
  function Harness() {
    const [activeTransport, setActiveTransport] = useState(transport);
    return <><button data-testid="replace-transport" onClick={() => setActiveTransport({ ...transport })}>Replace connection</button>
      <App baseUrl="http://localhost/" directory={directory} transport={activeTransport}
        hostService={{ hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('Not used'); } }}
        initialState={options.live ? undefined : { ...replicaState, agent: sessionSnapshots.parent, timeline: { ...replicaState.timeline, hasOlder: false, entries: options.letters ? letterEntries('parent') : options.navigation ? [activityEntry('native-child')] : [] } }} initialSessionStatus="ready"
        actions={{ sendMessage, respondToInteraction, uploadImage: async () => ({ attachmentId: 'parent-image', sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: 1, imageDimensions: { width: 1, height: 1 } }), listCommands: async () => [{ id: 'inspect', name: 'inspect', kind: 'skill', description: 'Inspect code' }] }} />
    </>;
  }
  const container = await render(<Harness />);
  return { container, attachments, resourceReads, sendMessage, respondToInteraction, releaseChild, resumeAgent, connections: () => connections };

}
it('focuses the current discovered session without another attachment or stream connection', async () => {
  const f = await setup(false, {live: true, discover: true, desktop: true});
  await draft(f.container, 'Keep current draft');
  const before = f.connections();
  for (let index = 0; index < 2; index++) {
    const row = f.container.querySelector<HTMLButtonElement>('[aria-label="Discover sessions"] .lab-session-row');
    expect(row).not.toBeNull();
    await act(async () => row!.click());
  }
  expect(f.attachments).toEqual([]);
  expect(f.connections()).toBe(before);
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep current draft');
});
async function draft(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function openAsk(container: HTMLElement) {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!.click());
  const ask = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Ask"]')!;
  expect(ask).not.toBeNull();
  await act(async () => ask.querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  await act(async () => ask.querySelector<HTMLInputElement>('input[value="simple"]')!.click());
  await act(async () => ask.querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  return ask;
}

it.each([false, true])('opens an independent Ask child through its own native parent (desktop=%s)', async desktop => {
  const f = await setup(false, { live: true, desktop, ask: true });
  const ask = await openAsk(f.container);
  const open = ask.querySelector<HTMLButtonElement>('[data-child-session-id="native-ask-child"]')!;
  expect(open.disabled).toBe(false);
  await act(async () => { open.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(f.attachments).toContainEqual({ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-ask', nativeSessionId: 'native-ask-child' } });
  expect(f.attachments).not.toContainEqual({ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-ask-child' } });
  if (desktop) {
    expect(f.container.querySelector('.lab-primary-conversation [data-child-session-id="native-ask-child"]')).not.toBeNull();
    const side = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
    expect(side.hidden).toBe(false);
    expect(side.textContent).toContain('Ask reviewer');
  } else await waitForSession(f.container, 'ask-child');
});

it('resolves Ask activity references within the Ask family', async () => {
  const f = await setup(false, { live: true, desktop: true, ask: true });
  const ask = await openAsk(f.container);
  const sessionLink = ask.querySelector<HTMLAnchorElement>('.agent-session-reference');
  expect(sessionLink).not.toBeNull();
  expect(new URL(sessionLink!.href).searchParams.get('session')).toBe('native-ask-child');
  await act(async () => { sessionLink!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(f.attachments).toContainEqual({ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-ask', nativeSessionId: 'native-ask-child' } });
});

it('shares the file preview host with Ask', async () => {
  const previousShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'show');
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    const f = await setup(false, { live: true, desktop: true, ask: true });
    const ask = await openAsk(f.container);
    const fileLink = ask.querySelector<HTMLButtonElement>('.agent-resource-link');
    expect(fileLink?.textContent).toBe('the source');
    expect(f.container.querySelectorAll('.agent-preview-workspace')).toHaveLength(1);
    await act(async () => { fileLink!.focus(); fileLink!.click(); });
    expect(f.resourceReads).toEqual([{ agentId: 'ask', locator: './ask-source.ts' }]);
    const preview = f.container.querySelector<HTMLDialogElement>('[aria-label="File preview"]')!;
    expect(preview.open).toBe(true);
    expect(preview.textContent).toContain('Ask source file is unavailable in this fixture.');
    await act(async () => preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(f.container.querySelector('[aria-label="File preview"]')).toBeNull();
    expect(f.container.querySelector('[role="dialog"][aria-label="Ask"]')).toBe(ask);
    expect(document.activeElement).toBe(fileLink);
  } finally {
    if (previousShow) Object.defineProperty(HTMLDialogElement.prototype, 'show', previousShow);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'show');
  }
});

it('resolves Side activity references within its source family', async () => {
  const f = await setup(false, { live: true, desktop: true, navigation: true });
  await act(async () => f.container.querySelector<HTMLButtonElement>('.lab-primary-conversation [data-child-session-id="native-child"]')!.click());
  const link = f.container.querySelector<HTMLAnchorElement>('.lab-side-conversation .agent-session-reference');
  expect(link).not.toBeNull();
  expect(new URL(link!.href).searchParams.get('session')).toBe('native-sibling');
});
it('opens a native child through its loaded parent and restores each conversation draft through breadcrumbs', async () => {
  const f = await setup();
  await draft(f.container, 'Parent draft');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.attachments).toEqual([{ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-child' } }]);
  expect(f.container.querySelector('[aria-label="Conversation path"]')?.textContent).toContain('Review transport');
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
  await draft(f.container, 'Child draft');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Parent draft');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Child draft');
});
it('keeps the parent conversation and draft visible when child attachment fails', async () => {
  const f = await setup(true);
  await draft(f.container, 'Keep my draft');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.container.querySelector('[role="alert"]')?.textContent).toContain('Child is unavailable.');
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep my draft');
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('parent');
});

it('keeps a selected skill with its parent draft and restores it after returning from a child', async () => {
  const f = await setup();
  await draft(f.container, '/inspect');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  await draft(f.container, 'Review this implementation');
  expect(f.container.querySelector('[aria-label="Selected skill"]')?.textContent).toContain('inspect');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.container.querySelector('[aria-label="Selected skill"]')).toBeNull();
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
  expect(f.container.querySelector('[aria-label="Selected skill"]')?.textContent).toContain('inspect');
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Review this implementation');
});

it('keeps the initial native parent image draft when returning after directory registration', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const f = await setup(false, { images: true });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => f.container.querySelector('[data-testid="prompt-input"]')!.dispatchEvent(paste));
  const originalId = f.container.querySelector('[data-image-id]')?.getAttribute('data-image-id');
  expect(originalId).toBeTruthy();
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.container.querySelector('[data-image-id]')).toBeNull();
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
  expect(f.container.querySelector('[data-image-id]')?.getAttribute('data-image-id')).toBe(originalId);
  expect(f.container.querySelector('[data-image-id]')?.textContent).toBe('[image #1]');
});

it('does not replace a newly connected parent when an older child attach finishes', async () => {
  const f = await setup(false, { live: true, deferChild: true });
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-testid="replace-transport"]')!.click());
  await act(async () => { f.releaseChild!(); });
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('parent');
  expect(f.container.querySelector('[aria-label="Conversation path"]')).toBeNull();
});

it('uses child input capabilities while keeping its native approval actionable', async () => {
  const f = await setup(false, { restricted: true });
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  const input = f.container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  expect(input.disabled).toBe(true);
  const hint = f.container.querySelector(`#${input.getAttribute('aria-describedby')}`)!;
  expect(hint.textContent).toBe('This session is read-only. Direct input is disabled.');
  expect(hint.classList.contains('agent-visually-hidden')).toBe(false);
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')?.disabled).toBe(true);
  const approve = [...f.container.querySelectorAll<HTMLButtonElement>('.agent-plan button')].find((button) => button.textContent === 'Approve');
  expect(approve?.disabled).toBe(false);
  await act(async () => approve!.click());
  expect(f.respondToInteraction).toHaveBeenCalledWith('child-plan', { kind: 'plan_approval', action: 'approve' });
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
  expect(f.container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.disabled).toBe(false);
  expect(f.container.textContent).not.toContain('This session is read-only.');
  await draft(f.container, 'Parent input');
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')?.disabled).toBe(false);
});

it('persists refreshed child titles over saved nicknames before switching conversations', async () => {
  const key = 'agent-remote-opened:http://localhost/';
  window.localStorage.setItem(key, JSON.stringify([
    { agentId: 'parent', providerId: 'codex', nativeSessionId: 'native-parent', title: 'Parent' },
    { agentId: 'child', providerId: 'codex', nativeSessionId: 'native-child', parentNativeSessionId: 'native-parent', parentAgentId: 'parent', title: 'Bohr' },
  ]));
  const f = await setup();
  const saved = () => JSON.parse(window.localStorage.getItem(key)!).find((item: { agentId: string }) => item.agentId === 'child');
  expect(saved().title).toBe('Review transport');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(saved().title).toBe('Review transport');
  expect(f.container.querySelector('[aria-label="Conversation path"]')?.textContent).toContain('Review transport');
});

it('releases view and delivery-persistence subscriptions while revisiting parent and child chats', async () => {
  const subscribe = AgentReplica.prototype.subscribe;
  const activeSubscriptions = new Map<AgentReplica, number>();
  const count = (agentId?: string) => [...activeSubscriptions].reduce((total, [replica, subscriptions]) =>
    agentId === undefined || replica.getState().agent?.id === agentId ? total + subscriptions : total, 0);
  vi.spyOn(AgentReplica.prototype, 'subscribe').mockImplementation(function (this: AgentReplica, listener) {
    const unsubscribe = subscribe.call(this, listener);
    activeSubscriptions.set(this, (activeSubscriptions.get(this) ?? 0) + 1);
    return () => { activeSubscriptions.set(this, activeSubscriptions.get(this)! - 1); unsubscribe(); };
  });
  const f = await setup(false, { live: true });
  expect(count('parent')).toBeGreaterThan(0);
  expect(count('child')).toBe(0);
  for (let revisit = 0; revisit < 3; revisit += 1) {
    await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
    expect(count('parent')).toBe(0);
    expect(count('child')).toBeGreaterThan(0);
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
    expect(count('child')).toBe(0);
    expect(count('parent')).toBeGreaterThan(0);
  }
  await unmount(f.container);
  expect(count()).toBe(0);
});

it('keeps desktop parent controls and uses child attachment without recreating a runtime', async () => {
  const f = await setup(false, { desktop: true });
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="session-resume"]')?.disabled).toBe(false);
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.container.querySelector('.lab-side-conversation .lab-side-title')?.textContent).toContain('Review transport');
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('parent');
  expect(f.resumeAgent).not.toHaveBeenCalled();
});

it('reattaches a resumable directory parent without creating another native runtime', async () => {
  const f = await setup(false, { desktop: true });
  await draft(f.container, 'Keep the root draft');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-testid="session-resume"]')!.click());
  expect(f.attachments).toEqual([{ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'native-parent' } }]);
  expect(f.resumeAgent).not.toHaveBeenCalled();
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep the root draft');
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('parent');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.attachments.at(-1)).toEqual({ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-child' } });
  expect(f.container.querySelector('.lab-side-conversation .lab-side-title')?.textContent).toContain('Review transport');
});

it('navigates through the chat session manager and keeps sibling discovery after switching', async () => {
  const f = await setup(false, { live: true, desktop: true });
  const manager = () => f.container.querySelector('[aria-label="Chat sessions"]')!;
  expect(manager().querySelector('.lab-session-tree')).toBeNull();
  expect(manager().querySelector('[aria-expanded="false"]')).not.toBeNull();
  await act(async () => manager().querySelector<HTMLButtonElement>('.lab-chat-sessions-heading')!.click());
  expect(manager().textContent).toContain('Review transport');
  await act(async () => [...manager().querySelectorAll<HTMLButtonElement>('.lab-session-row')].find((row) => row.textContent?.includes('Review transport'))!.click());
  expect(f.attachments).toEqual([{ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-child' } }]);
  expect(manager().querySelector('.lab-chat-sessions-heading')?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => (manager().querySelector('.lab-chat-sessions-heading') as HTMLButtonElement).click());
  expect(manager().querySelector('[aria-current="page"]')?.textContent).toContain('Review transport');
  const discovery = f.container.querySelector('[aria-label="Discover sessions"]')!;
  expect(discovery.querySelector('.lab-session-tree .lab-session-tree')).toBeNull();
  await act(async () => discovery.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
  expect(discovery.querySelector('.lab-session-tree .lab-session-tree')?.textContent).toContain('Review transport');
  await act(async () => [...manager().querySelectorAll<HTMLButtonElement>('.lab-session-row')].find((row) => row.textContent?.includes('Parent'))!.click());
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('parent');
});

function activityEntry(nativeSessionId: string) {
  const title = `/root/${nativeSessionId.replace('native-', '')}`;
  return { providerId: 'codex', turnId: 'turn', timestamp: '2026-09-16T00:00:00Z', seqStart: 1, seqEnd: 1,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
    item: { type: 'tool_call' as const, callId: 'activity', name: 'agent.activity', status: 'completed' as const, error: null,
      detail: { type: 'other' as const, description: `Agent ${title}: interacted`, sessionReference: { nativeSessionId, title } } },
  };
}

async function waitForSession(container: HTMLElement, agent: string) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain(agent);
}

it('navigates activity links between a parent and siblings with browser and conversation back/forward', async () => {
  const f = await setup(false, { navigation: true });
  await draft(f.container, 'Parent draft');
  const back = () => f.container.querySelector<HTMLButtonElement>('[aria-label="Back to previous conversation"]')!;
  const forward = () => f.container.querySelector<HTMLButtonElement>('[aria-label="Forward to next conversation"]')!;
  expect(back().disabled).toBe(true);
  await act(async () => f.container.querySelector<HTMLAnchorElement>('.agent-session-reference')!.click());
  await waitForSession(f.container, 'child');
  await draft(f.container, 'Child draft');
  await act(async () => f.container.querySelector<HTMLAnchorElement>('.agent-session-reference')!.click());
  await waitForSession(f.container, 'sibling');
  expect(f.attachments).toEqual([
    { path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-child' } },
    { path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-sibling' } },
  ]);
  await act(async () => back().click());
  await waitForSession(f.container, 'child');
  expect(f.container.querySelector('textarea')!.value).toBe('Child draft');
  await act(async () => window.history.back());
  await waitForSession(f.container, 'parent');
  expect(f.container.querySelector('textarea')!.value).toBe('Parent draft');
  expect(back().disabled).toBe(true);
  await act(async () => forward().click());
  await waitForSession(f.container, 'child');
  await act(async () => window.history.forward());
  await waitForSession(f.container, 'sibling');
  expect(forward().disabled).toBe(true);
  await act(async () => f.container.querySelector<HTMLAnchorElement>('.agent-session-reference')!.click());
  await waitForSession(f.container, 'parent');
  await act(async () => back().click());
  await waitForSession(f.container, 'sibling');
});

it('shows known grandchildren in the parent timeline and attaches through their actual parent', async () => {
  const f = await setup(false, { nested: true });
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id="native-child"]')!.click());
  await waitForSession(f.container, 'child');
  expect(f.container.querySelector('[data-child-session-id="native-grandchild"]')?.textContent).toContain('Working');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Back to previous conversation"]')!.click());
  await waitForSession(f.container, 'parent');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Expand subagents of Review transport"]')!.click());
  const nested = f.container.querySelector<HTMLButtonElement>('[data-child-session-id="native-grandchild"]')!;
  expect(nested).not.toBeNull();
  await act(async () => nested.click());
  await waitForSession(f.container, 'grandchild');
  expect(f.attachments.at(-1)).toEqual({ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-child', nativeSessionId: 'native-grandchild' } });
});

function letterEntries(agent: string, rootReference = false): import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry[] {
  const reference = activityEntry('native-parent');
  reference.item.detail.sessionReference.title = '/root';
  return [
    { providerId: 'codex', seqStart: 1, seqEnd: 1, timestamp: '2026-09-29T00:00:00Z', resources: [], collapsed: [], sourceSeqRanges: [{startSeq: 1, endSeq: 1}],
      ...(agent === 'child' ? { turnId: 'child-turn' } : {}),
      item: { type: 'agent_communication', messageId: 'task-letter', sender: '/root', recipient: '/root/review', text: 'Review the transport.' } },
    { providerId: 'codex', seqStart: 2, seqEnd: 2, timestamp: '2026-09-29T00:00:01Z', resources: [], collapsed: [], sourceSeqRanges: [{startSeq: 2, endSeq: 2}], turnId: agent + '-turn',
      item: { type: 'assistant_message', messageId: 'work-' + agent, text: 'Working after receiving the letter.' } },
    { providerId: 'codex', seqStart: 3, seqEnd: 3, timestamp: '2026-09-29T00:00:02Z', resources: [], collapsed: [], sourceSeqRanges: [{startSeq: 3, endSeq: 3}],
      ...(agent === 'parent' ? { turnId: 'parent-turn' } : {}),
      item: { type: 'agent_communication', messageId: 'reply-letter', sender: '/root/review', recipient: '/root', text: 'The transport review is complete.' } },
    ...(rootReference && agent === 'child' ? [{ ...reference, timestamp: '2026-09-29T00:00:03Z', seqStart: 4, seqEnd: 4, sourceSeqRanges: [{ startSeq: 4, endSeq: 4 }] }] : []),
  ];
}
it('opens desktop subagents side by side and preserves both drafts when focusing or closing a pane', async () => {
  const f = await setup(false, { desktop: true, live: true });
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  await draft(primary, 'Parent stays');
  await act(async () => primary.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  const side = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
  expect(primary.hidden).toBe(false); expect(side.hidden).toBe(false);
  await draft(side, 'Child stays');
  await act(async () => primary.click());
  expect(side.hidden).toBe(false);
  expect(primary.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Parent stays');
  expect(side.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Child stays');
  await act(async () => side.querySelector<HTMLButtonElement>('.lab-side-close')!.click());
  expect(side.hidden).toBe(true); expect(primary.hidden).toBe(false);
});
it('opens a letter from its original position, docks toward the receiver and reveals either direction without replacing the pair', async () => {
  const f = await setup(false, { desktop: true, live: true, letters: true });
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  expect(primary.querySelector('.agent-communication-letter')?.getAttribute('data-direction')).toBeNull();
  const open = primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root to /root/review"]')!;
  await act(async () => { open.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  const side = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
  expect(side).not.toBeNull(); expect(primary.hidden).toBe(false); expect(side.hidden).toBe(false);
  expect(primary.querySelector('.agent-communication-letter')?.getAttribute('data-direction')).toBe('right');
  expect(side.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('task-letter');
  const connections = f.connections();
  await act(async () => { side.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root/review to /root"]')!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(primary.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('reply-letter');
  expect(side.querySelectorAll('.agent-communication-letter')[1]?.getAttribute('data-direction')).toBe('left');
  expect(f.connections()).toBe(connections);
  expect(primary.hidden).toBe(false); expect(side.hidden).toBe(false);
});

it('opens a directly linked child letter with its previously unobserved parent', async () => {
  const f = await setup(false, { desktop: true, live: true, letters: true, directChild: true });
  await waitForSession(f.container, 'child');
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  await act(async () => {
    primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root/review to /root"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  const side = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
  expect(primary.hidden).toBe(false);
  expect(side).not.toBeNull();
  expect(side.hidden).toBe(false);
  expect(side.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('reply-letter');
  expect(f.container.querySelector('.agent-communication-letter [role="alert"]')).toBeNull();
});
it('opens nested desktop subagents next to their direct parent', async () => {
  const f = await setup(false, { desktop: true, live: true, nested: true });
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id="native-child"]')!.click());
  const side = f.container.querySelector<HTMLElement>('.lab-side-conversation')!;
  await act(async () => side.querySelector<HTMLButtonElement>('[data-child-session-id="native-grandchild"]')!.click());
  const sides = [...f.container.querySelectorAll<HTMLElement>('.lab-side-conversation')];
  expect(sides).toHaveLength(2);
  expect(sides.every(pane => !pane.hidden)).toBe(true);
  expect(f.attachments.at(-1)).toEqual({ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-child', nativeSessionId: 'native-grandchild' } });
});

it('replaces the current mobile conversation with the letter recipient and preserves both drafts', async () => {
  const f = await setup(false, { live: true, letters: true });
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  await draft(primary, 'Parent draft stays');
  await act(async () => {
    primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root to /root/review"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(primary.hidden).toBe(false);
  expect(f.container.querySelector('.lab-side-conversation')).toBeNull();
  expect(primary.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('task-letter');
  await waitForSession(f.container, 'child');
  expect(primary.querySelector<HTMLTextAreaElement>('textarea')?.value).not.toBe('Parent draft stays');
  await draft(primary, 'Child draft stays');
  await act(async () => {
    primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root/review to /root"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await waitForSession(f.container, 'parent');
  expect(primary.hidden).toBe(false);
  expect(f.container.querySelector('.lab-side-conversation')).toBeNull();
  expect(primary.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('reply-letter');
  expect(primary.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Parent draft stays');
  await act(async () => {
    primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root to /root/review"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(primary.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Child draft stays');
});
it('opens the sender when the mobile view already belongs to the recipient', async () => {
  const f = await setup(false, { live: true, letters: true });
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  await act(async () => {
    primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root/review to /root"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(primary.hidden).toBe(false);
  expect(f.container.querySelector('.lab-side-conversation')).toBeNull();
  await waitForSession(f.container, 'child');
  expect(primary.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('reply-letter');
  await act(async () => {
    primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root/review to /root"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await waitForSession(f.container, 'parent');
  expect(primary.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('reply-letter');
});

it.each([false, true])('keeps the main session title when a child letter uses its native /root path (desktop=%s)', async desktop => {
  window.localStorage.setItem('agent-remote-opened:http://localhost/', JSON.stringify([
    { hostId: 'local', providerId: 'codex', nativeSessionId: 'native-parent', agentId: 'parent', title: 'Main project conversation' },
  ]));
  const f = await setup(false, { live: true, letters: true, rootReference: true, directChild: true, desktop });
  await waitForSession(f.container, 'child');
  const primary = f.container.querySelector<HTMLElement>('.lab-primary-conversation')!;
  await act(async () => {
    primary.querySelector<HTMLButtonElement>('[aria-label="Open letter from /root/review to /root"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  if (!desktop) await waitForSession(f.container, 'parent');
  const destination = desktop ? f.container.querySelector('.lab-side-conversation')! : primary;
  expect(f.container.querySelector(desktop ? '.lab-side-title-text' : '.lab-mobile-session-title')?.textContent).toBe('Main project conversation');
  expect(destination.querySelector('[data-inspected="true"]')?.getAttribute('data-entry-key')).toContain('reply-letter');
});


it.each([false, true])('toggles the current session Ask entry from View without creating a session (desktop=%s)', async desktop => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const f = await setup(false, { live: true, desktop });
  const view = f.container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!;
  await act(async () => view.click());
  const control = () => Array.from(f.container.querySelectorAll('label')).find(label => label.textContent === 'Ask view')?.querySelector<HTMLInputElement>('input');
  expect(control()).toBeDefined();
  expect(control()!.checked).toBe(false);
  expect(f.container.querySelector('[aria-label="Ask about this session"]')).toBeNull();
  const before = f.connections();
  await act(async () => control()!.click());
  expect(control()!.checked).toBe(true);
  expect(f.container.querySelector('[aria-label="Ask about this session"]')).not.toBeNull();
  expect(f.container.querySelector('[role="dialog"][aria-label="Ask"]')).toBeNull();
  expect(f.attachments).toEqual([]);
  expect(f.connections()).toBe(before);
  await act(async () => control()!.click());
  expect(control()!.checked).toBe(false);
  expect(f.container.querySelector('[aria-label="Ask about this session"]')).toBeNull();
  expect(f.attachments).toEqual([]);
});


it('keeps the View Ask toggle scoped to the selected session and restores its preference', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const f = await setup(false, { live: true, desktop: true });
  const toggleView = () => act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
  const control = () => f.container.querySelector<HTMLInputElement>('[data-view-control="ask"]')!;
  await toggleView();
  await act(async () => control().click());
  await toggleView();
  await act(async () => f.container.querySelector<HTMLButtonElement>('.lab-primary-conversation [data-child-session-id="native-child"]')!.click());
  await toggleView();
  expect(control().checked).toBe(false);
  expect(f.container.querySelector('.lab-primary-conversation [aria-label="Ask about this session"]')).not.toBeNull();
  expect(f.container.querySelector('.lab-side-conversation [aria-label="Ask about this session"]')).toBeNull();
  await act(async () => control().click());
  expect(f.container.querySelector('.lab-side-conversation [aria-label="Ask about this session"]')).not.toBeNull();
  await act(async () => control().click());
  expect(f.container.querySelector('.lab-primary-conversation [aria-label="Ask about this session"]')).not.toBeNull();
  await unmount(f.container);
  const restored = await setup(false, { live: true, desktop: true });
  await act(async () => restored.container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
  expect(restored.container.querySelector<HTMLInputElement>('[data-view-control="ask"]')!.checked).toBe(true);
});
