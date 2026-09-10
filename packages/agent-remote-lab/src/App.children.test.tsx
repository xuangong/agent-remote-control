import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type AgentChildSession } from '@borgee/agent-remote-protocol';
import { AgentReplica } from '@borgee/agent-remote-web';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient } from './directory-client.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

const child: AgentChildSession = { nativeSessionId: 'native-child', title: 'Review transport', role: 'Reviewer', createdAt: '2026-09-10T00:00:00Z', status: 'idle', observation: 'live' };
const parent = { ...replicaState.agent!, id: 'parent', providerId: 'codex', persistence: { providerId: 'codex', sessionId: 'native-parent', opaque: 'native-parent' }, capabilities: { ...replicaState.agent!.capabilities, commands: true }, runtimeInfo: { providerId: 'codex', sessionId: 'native-parent', status: 'idle' as const, childSessions: [child] } };
const snapshots = {
  parent,
  child: { ...parent, id: 'child', persistence: { providerId: 'codex', sessionId: 'native-child', opaque: 'native-child' }, runtimeInfo: { providerId: 'codex', sessionId: 'native-child', status: 'idle' as const } },
};
afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); window.history.replaceState(null, '', '/'); });
async function setup(reject = false, options: { live?: boolean; deferChild?: boolean; restricted?: boolean } = {}) {
  let releaseChild: (() => void) | undefined;
  const childReady = options.deferChild ? new Promise<void>((resolve) => { releaseChild = resolve; }) : Promise.resolve();
  const sessionSnapshots = { ...snapshots, child: options.restricted ? { ...snapshots.child, capabilities: { ...snapshots.child.capabilities, sendMessage: false, cancel: false }, pendingInteractions: [{ kind: 'plan_approval' as const, requestId: 'child-plan', plan: 'Review the child plan', allowedActions: ['approve' as const] }] } : snapshots.child };
  const attachments: unknown[] = [];
  const directory = new SessionDirectoryClient('http://localhost/', async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ items: [], hasMore: false, revision: '1' });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    if (path.endsWith('/attach')) {
      attachments.push({ path, body: JSON.parse(String(init?.body)) });
      if (path.endsWith('/child/attach')) await childReady;
      if (reject) return Response.json({ error: 'Child is unavailable.' }, { status: 409 });
      return Response.json({ agentId: path.endsWith('/child/attach') ? 'child' : 'parent', nativeSessionId: path.endsWith('/child/attach') ? 'native-child' : 'native-parent' });
    }
    throw new Error(`Unexpected directory path: ${path}`);
  });
  const resumeAgent = vi.fn(async () => { throw new Error('Native runtime must not be recreated.'); });
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'codex', displayName: 'Codex' }],
    createAgent: async () => { throw new Error('Not used'); }, resumeAgent,
    fetchSnapshot: async (agentId) => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: sessionSnapshots[agentId as keyof typeof sessionSnapshots] }),
    fetchTimeline: async (agentId) => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'page', agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect: (agentId, listener) => {
      queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: sessionSnapshots[agentId as keyof typeof sessionSnapshots] }));
      return { close() {}, send(message) {
        if (message.type === 'timeline_subscription') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } }));
      } };
    },
    onDiagnostic: () => () => {},
    onProtocolMessage: () => () => {},
  };
  const sendMessage = vi.fn(async () => {});
  const respondToInteraction = vi.fn(async () => {});
  if (options.live) window.history.replaceState(null, '', '/?agent=parent');
  function Harness() {
    const [activeTransport, setActiveTransport] = useState(transport);
    return <><button data-testid="replace-transport" onClick={() => setActiveTransport({ ...transport })}>Replace connection</button>
      <App baseUrl="http://localhost/" directory={directory} transport={activeTransport}
        hostService={{ hosts: async () => ({ hosts: [] }), pair: async () => { throw new Error('Not used'); } }}
        initialState={options.live ? undefined : { ...replicaState, agent: parent, timeline: { ...replicaState.timeline, hasOlder: false } }} initialSessionStatus="ready"
        actions={{ sendMessage, respondToInteraction, listCommands: async () => [{ id: 'inspect', name: 'inspect', kind: 'skill', description: 'Inspect code' }] }} />
    </>;
  }
  const container = await render(<Harness />);
  return { container, attachments, sendMessage, respondToInteraction, releaseChild, resumeAgent };

}
async function draft(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
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
  await draft(f.container, 'A child draft');
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')?.disabled).toBe(true);
  const approve = [...f.container.querySelectorAll<HTMLButtonElement>('.agent-plan button')].find((button) => button.textContent === 'Approve');
  expect(approve?.disabled).toBe(false);
  await act(async () => approve!.click());
  expect(f.respondToInteraction).toHaveBeenCalledWith('child-plan', { kind: 'plan_approval', action: 'approve' });
});

it('owns only one active replica subscription while revisiting parent and child chats', async () => {
  const subscribe = AgentReplica.prototype.subscribe;
  let activeSubscriptions = 0;
  vi.spyOn(AgentReplica.prototype, 'subscribe').mockImplementation(function (this: AgentReplica, listener) {
    const unsubscribe = subscribe.call(this, listener);
    activeSubscriptions += 1;
    return () => { activeSubscriptions -= 1; unsubscribe(); };
  });
  const f = await setup(false, { live: true });
  expect(activeSubscriptions).toBe(1);
  for (let revisit = 0; revisit < 3; revisit += 1) {
    await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
    expect(activeSubscriptions).toBe(1);
    await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
    expect(activeSubscriptions).toBe(1);
  }
});

it('offers persistence resume only for the parent and keeps child navigation on child attachment', async () => {
  const f = await setup();
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="session-resume"]')?.disabled).toBe(false);
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  const resume = f.container.querySelector<HTMLButtonElement>('[data-testid="session-resume"]')!;
  expect(resume.disabled).toBe(true);
  await act(async () => resume.click());
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('child');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Conversation path"] button')!.click());
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="session-resume"]')?.disabled).toBe(false);
});

it('reattaches a resumable directory parent without creating another native runtime', async () => {
  const f = await setup();
  await draft(f.container, 'Keep the root draft');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-testid="session-resume"]')!.click());
  expect(f.attachments).toEqual([{ path: '/v1/remote/attach', body: { providerId: 'codex', nativeSessionId: 'native-parent' } }]);
  expect(f.resumeAgent).not.toHaveBeenCalled();
  expect(f.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep the root draft');
  expect(f.container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('parent');
  await act(async () => f.container.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
  expect(f.attachments.at(-1)).toEqual({ path: '/v1/remote/child/attach', body: { providerId: 'codex', parentNativeSessionId: 'native-parent', nativeSessionId: 'native-child' } });
  expect(f.container.querySelector('[aria-label="Conversation path"]')?.textContent).toContain('Review transport');
});
