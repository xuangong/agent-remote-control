import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type AgentProviderDescriptor,
  type AgentSessionResponse,
} from '@agent-remote-controller/agent-remote-protocol';
import type { RemoteTransportListener } from '@agent-remote-controller/agent-remote-web';

import { App, type LabTransport } from './App.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

describe('App', () => {
  it('reveals a filtered execution event when explicitly opening it from Trace', async () => {
    const key = 'agent-remote:timeline-display';
    window.localStorage.setItem(key, 'content');
    const initialState = { ...replicaState, timeline: { ...replicaState.timeline, entries: [{
      providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-18T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
      item: { type: 'reasoning' as const, text: 'Inspect this reasoning.' },
    }] } };
    try {
      const container = await render(<App initialState={initialState} initialSessionStatus="ready" actions={{}} />);
      expect(container.querySelector('.agent-reasoning')).toBeNull();
      await act(async () => tab(container, 'Trace').click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-trace-entry-key]')!.click());
      const show = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Show in Conversation')!;
      await act(async () => show.click());
      expect(tab(container, 'Workbench').getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('[data-inspected="true"] .agent-reasoning')).not.toBeNull();
      expect(window.localStorage.getItem(key)).toBe('simple');
    } finally { window.localStorage.removeItem(key); }
  });

  it('offers content-only above simple view, switches modes exclusively, and restores content-only after remount', async () => {
    const key = 'agent-remote:timeline-display';
    window.localStorage.removeItem(key);
    const initialState = { ...replicaState, timeline: { ...replicaState.timeline, entries: [
      { type: 'user_message' as const, text: 'The requirement.' },
      { type: 'reasoning' as const, text: 'Execution details.' },
      { type: 'assistant_message' as const, text: 'The summary.' },
    ].map((item, index) => ({ providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1,
      timestamp: '2026-09-18T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item })) } };
    try {
      const container = await render(<App initialState={initialState} initialSessionStatus="ready" actions={{}} />);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
      const content = container.querySelector<HTMLInputElement>('[aria-label="Content only view"]');
      const simple = container.querySelector<HTMLInputElement>('[aria-label="Simple conversation view"]')!;
      expect(content).not.toBeNull();
      expect(content!.compareDocumentPosition(simple) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await act(async () => content!.click());
      expect(simple.checked).toBe(false);
      expect(container.querySelectorAll('.agent-timeline-entry')).toHaveLength(2);
      expect(container.querySelector('.agent-message-user')?.textContent).toContain('The requirement.');
      expect(container.querySelector('.agent-message-assistant')?.textContent).toContain('The summary.');
      expect(window.localStorage.getItem(key)).toBe('content');
      const restored = await render(<App initialState={initialState} initialSessionStatus="ready" actions={{}} />);
      expect(restored.querySelectorAll('.agent-timeline-entry')).toHaveLength(2);
      await act(async () => simple.click());
      expect(content!.checked).toBe(false);
      expect(container.querySelectorAll('.agent-timeline-entry')).toHaveLength(3);
      expect(container.querySelector('.agent-content-preview')).toBeNull();
      await act(async () => content!.click());
      expect(simple.checked).toBe(false);
      await act(async () => content!.click());
      expect(window.localStorage.getItem(key)).toBe('preview');
      expect(container.querySelector('.agent-content-preview')?.textContent).toContain('Execution details.');
    } finally { window.localStorage.removeItem(key); }
  });

  it('does not restore an old inspect request after leaving and returning to a session', async () => {
    window.history.replaceState(null, '', '/?agent=agent-1');
    let creations = 0;
    const transport = labTransport({
      createAgent: async () => sessionResponse(++creations === 1 ? 'agent-2' : 'agent-1'),
      fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
        requestId: 'history', agentId, epoch: 'epoch-1', direction: 'tail', reset: false, staleCursor: false, gap: false,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: 'epoch-1', seq: 1 }, endCursor: { epoch: 'epoch-1', seq: 1 },
        hasOlder: false, hasNewer: false, error: null, entries: [{ providerId: 'recorded', timestamp: '2026-09-17T00:00:00Z',
          seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
          item: { type: 'assistant_message', text: agentId, messageId: 'reply' },
        }],
      } }),
      connect: (agentId, listener) => {
        queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { ...replicaState.agent!, id: agentId } }));
        return { close: () => {}, send: message => {
          if (message.type === 'timeline_subscription') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION,
            type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] },
          }));
        } };
      },
    });
    const container = await render(<App transport={transport} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Inspect event #1 in Trace"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-trace-close')!.click());
    for (let index = 0; index < 2; index += 1) {
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-create"]')!.click());
    }
    expect(creations).toBe(2);
    await act(async () => tab(container, 'Trace').click());
    expect(container.querySelector('[data-trace-entry-key]')?.textContent).toContain('agent-1');
    expect(container.querySelector('[data-trace-entry-key][aria-current="true"]')).toBeNull();
  });

  it('links a conversation entry to its trace and returns without remounting the conversation', async () => {
    const state = { ...replicaState, timeline: { ...replicaState.timeline, entries: [{
      providerId: 'recorded', seqStart: 2, seqEnd: 4, timestamp: '2026-09-17T00:00:00Z',
      sourceSeqRanges: [{ startSeq: 2, endSeq: 4 }], collapsed: [], resources: [],
      item: { type: 'assistant_message' as const, messageId: 'reply', text: 'Inspect this response.' },
    }] } };
    const container = await render(<App initialState={state} initialSessionStatus="ready" actions={{}} />);
    const conversation = container.querySelector('[data-entry-key]');
    const inspect = conversation?.querySelector<HTMLButtonElement>('[aria-label="Inspect event #2 in Trace"]');
    expect(inspect).not.toBeNull();
    expect(inspect).toBeDefined();
    await act(async () => inspect!.click());
    expect(tab(container, 'Trace').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[aria-label="Trace entry details"]')?.textContent).toContain('Inspect this response.');
    const back = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Show in Conversation');
    expect(back).toBeDefined();
    await act(async () => back!.click());
    expect(tab(container, 'Workbench').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-entry-key]')).toBe(conversation);
    expect(conversation?.getAttribute('data-inspected')).toBe('true');
  });

  it('switches conversation previews from View and restores the browser preference', async () => {
    const key = 'agent-remote:timeline-display';
    window.localStorage.removeItem(key);
    const initialState = { ...replicaState, timeline: { ...replicaState.timeline, entries: [{
      providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-15T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [], item: { type: 'reasoning' as const, text: 'Review the failing test first.' },
    }] } };
    try {
      const container = await render(<App initialState={initialState} transport={labTransport()} />);
      expect(container.querySelector('.agent-content-preview')?.textContent).toContain('Review the failing test');
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
      const simple = container.querySelector<HTMLInputElement>('[aria-label="Simple conversation view"]');
      expect(simple).not.toBeNull();
      await act(async () => simple!.click());
      expect(container.querySelector('.agent-content-preview')).toBeNull();
      expect(window.localStorage.getItem(key)).toBe('simple');
      const restored = await render(<App initialState={initialState} transport={labTransport()} />);
      expect(restored.querySelector('.agent-content-preview')).toBeNull();
      await act(async () => simple!.click());
      expect(container.querySelector('.agent-content-preview')).not.toBeNull();
    } finally { window.localStorage.removeItem(key); }
  });

  it('opens a native child link without cached sessions and ignores a stale runtime Agent ID', async () => {
    window.history.replaceState(null, '', '/?host=desk&agent=stale&provider=codex&session=child&parent=parent');
    const request = vi.fn(async () => Response.json({ agentId: 'current-child', nativeSessionId: 'child' }));
    vi.stubGlobal('fetch', request);
    const connect = vi.fn(() => ({ send: () => undefined, close: () => undefined }));
    try {
      await render(<App baseUrl="http://localhost/tenant/" transport={labTransport({ connect })} />);
      expect(request).toHaveBeenCalledOnce();
      const [url, options] = request.mock.calls[0] as unknown as [URL, RequestInit];
      expect(url.pathname).toBe('/tenant/v1/remote/hosts/desk/child/attach');
      expect(JSON.parse(options.body as string)).toEqual({ providerId: 'codex', nativeSessionId: 'child', parentNativeSessionId: 'parent' });
      expect(connect).toHaveBeenCalledWith('current-child', expect.any(Object));
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not fall back to the runtime Agent when a native session link is denied', async () => {
    window.history.replaceState(null, '', '/?host=desk&agent=stale&provider=codex&session=private');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Session access denied.' }, { status: 403 })));
    const connect = vi.fn();
    try {
      const container = await render(<App transport={labTransport({ connect })} />);
      expect(container.textContent).toContain('Session access denied.');
      expect(connect).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('requests planning explicitly at creation and shows an unsupported error without attaching an ordinary session', async () => {
    const createAgent = vi.fn().mockRejectedValue(new Error('Planning is not supported by this Provider.'));
    const connect = vi.fn();
    const container = await render(<App transport={labTransport({ createAgent, connect })} />);
    const mode = container.querySelector<HTMLSelectElement>('#session-mode')!;
    await act(async () => { mode.value = 'planning'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-create"]')!.click());
    expect(createAgent).toHaveBeenCalledWith(expect.any(String), 'recorded', expect.objectContaining({ planning: true }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Planning is not supported');
    expect(connect).not.toHaveBeenCalled();
    expect(mode.value).toBe('planning');
  });

  it('omits a planning request for ordinary session creation', async () => {
    const createAgent = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const container = await render(<App transport={labTransport({ createAgent })} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-create"]')!.click());
    expect(createAgent.mock.calls[0]?.[2]).toEqual({ sessionId: expect.any(String) });
  });

  it('retains question choices and custom answers while switching between conversation and trace', async () => {
    const state = { ...replicaState, pendingInteractions: [{
      kind: 'question' as const, requestId: 'questions', questions: [
        { questionId: 'one', header: 'First', prompt: 'Choose one', selection: 'single' as const, required: true, options: [{ value: 'web', label: 'Web' }], allowCustomText: false, allowDismiss: false },
        { questionId: 'two', header: 'Second', prompt: 'Add details', selection: 'multiple' as const, required: true, options: [{ value: 'test', label: 'Test' }], allowCustomText: true, allowDismiss: false },
      ],
    }] };
    const respond = vi.fn().mockResolvedValue(undefined);
    const container = await render(<App initialState={state} initialSessionStatus="ready" actions={{ respondToInteraction: respond }} />);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="web"]')!.click());
    await act(async () => container.querySelector<HTMLInputElement>('input[value="test"]')!.click());
    const custom = container.querySelector<HTMLInputElement>('input[name="two-custom"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, 'Keep details');
      custom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => tab(container, 'Trace').click());
    await act(async () => tab(container, 'Workbench').click());
    expect(custom.value).toBe('Keep details');
    expect(container.querySelector<HTMLInputElement>('input[value="web"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="test"]')?.checked).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('.agent-question button[type="submit"]')!.click());
    expect(respond).toHaveBeenCalledExactlyOnceWith('questions', { kind: 'question', answers: [
      { questionId: 'one', selectedValues: ['web'] }, { questionId: 'two', selectedValues: ['test'], customText: 'Keep details' },
    ] });
  });

  it('names the Provider catalog request while it is pending', async () => {
    const providers = deferred<readonly AgentProviderDescriptor[]>();
    const container = await render(<App transport={labTransport({ listProviders: () => providers.promise })} />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading providers');
    expect((container.querySelector('[data-testid="session-create"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('distinguishes an empty Provider catalog from a failed request', async () => {
    const container = await render(<App transport={labTransport({ listProviders: async () => [] })} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('No Provider is registered');
    expect(container.querySelector('[data-testid="provider-retry"]')).toBeNull();
  });

  it('retries a failed Provider catalog request', async () => {
    let attempts = 0;
    const transport = labTransport({
      listProviders: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Catalog unavailable.');
        return [{ providerId: 'recorded', displayName: 'Recorded semantic Provider' }];
      },
    });
    const container = await render(<App transport={transport} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Catalog unavailable.');
    await act(async () => (container.querySelector('[data-testid="provider-retry"]') as HTMLButtonElement).click());
    expect((container.querySelector('[data-testid="provider-select"]') as HTMLSelectElement).value).toBe('recorded');
  });

  it('keeps the Timeline work surface while a remembered Agent connects', async () => {
    window.history.replaceState(null, '', '/?agent=remembered-agent');
    try {
      const container = await render(<App transport={labTransport()} />);
      expect(container.querySelector('[data-testid="workbench"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('Connecting');
      expect(container.textContent).toContain('Connecting to remembered-agent');
      expect(container.textContent).not.toContain('Start with a Provider');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it.each([
    ['catching_up', 'Synchronizing'],
    ['disconnected', 'Reconnecting'],
  ] as const)('presents %s as %s without discarding the last replica', async (sessionStatus, label) => {
    const container = await render(<App initialState={replicaState} initialSessionStatus={sessionStatus} actions={{}} />);
    expect(container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain(label);
    expect(container.querySelector('[aria-label="Agent timeline"]')).not.toBeNull();
  });

  it('presents a failed Agent instead of shadowing it with connection readiness', async () => {
    const agent = replicaState.agent;
    if (!agent) throw new Error('The App fixture requires an Agent Snapshot.');
    const state = {
      ...replicaState,
      agent: { ...agent, status: 'failed' as const, lastError: 'Provider observation stream failed.' },
    };
    const container = await render(<App initialState={state} initialSessionStatus="ready" actions={{}} />);
    const summary = container.querySelector('[data-testid="connection-summary"]') as HTMLElement;

    expect(summary.textContent).toContain('Agent failed');
    expect(summary.textContent).not.toContain('Ready');
    expect(summary.getAttribute('aria-label')).toContain('Agent failed');
    expect(summary.getAttribute('aria-label')).not.toContain('Ready');
  });

  it('hides Lab scenario controls when fixture callbacks are unavailable', async () => {
    const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{}} />);

    expect(container.querySelector('[aria-label="Lab scenario controls"]')).toBeNull();
  });

  it.each(['recorded', 'codex', 'dsh'])('offers recorded playback only for a recorded session with %s active', async (providerId) => {
    const state = { ...replicaState, agent: { ...replicaState.agent!, providerId } };
    const fixtureAction = vi.fn().mockResolvedValue(undefined);
    const container = await render(<App initialState={state} initialSessionStatus="ready" fixtureAction={fixtureAction} />);
    const advance = container.querySelector<HTMLButtonElement>('[data-testid="playback-advance"]');
    if (providerId === 'recorded') {
      expect(advance).not.toBeNull();
      await act(async () => advance!.click());
      expect(fixtureAction).toHaveBeenCalledWith(state.agent.id, 'advance');
    } else {
      expect(advance).toBeNull();
      expect(fixtureAction).not.toHaveBeenCalled();
    }
  });

  it('composes Snapshot, Timeline, interactions, resources, and fixture controls without Provider branches', async () => {
    const state = {
      ...replicaState,
      timeline: {
        ...replicaState.timeline,
        entries: [{
          providerId: 'recorded', seqStart: 6, seqEnd: 6,
          timestamp: '2026-09-02T00:00:05.000Z',
          sourceSeqRanges: [{ startSeq: 6, endSeq: 6 }], collapsed: [],
          item: { type: 'assistant_message' as const, text: 'Visible tail.', messageId: 'tail' },
          resources: [],
        }],
      },
    };
    const loadOlder = vi.fn();
    const container = await render(<App
      initialState={state}
      initialSessionStatus="ready"
      initialProviderName="Recorded semantic Provider"
      actions={{ loadOlder }}
    />);

    expect(container.querySelector('[aria-label="Agent timeline"]')?.textContent).toContain('Visible tail.');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
    await act(async () => container.querySelector<HTMLInputElement>('[aria-controls="lab-inspector"]')!.click());
    expect(container.querySelector('#lab-inspector')?.textContent).toContain('Recorded semantic Provider');
    expect(container.querySelector('[data-testid="timeline-epoch"]')?.textContent).toBe('epoch-1');
    await act(async () => { (container.querySelector('.agent-load-older') as HTMLButtonElement).click(); });
    expect(loadOlder).toHaveBeenCalledOnce();
  });

  it('opens in Workbench and preserves mounted work while switching to the public replica trace', async () => {
    const container = await render(<App
      initialState={replicaState}
      initialSessionStatus="ready"
      actions={{ sendMessage: vi.fn() }}
    />);
    const workbenchTab = tab(container, 'Workbench');
    const traceTab = tab(container, 'Trace');
    const workbench = container.querySelector('[data-testid="workbench"]') as HTMLElement;
    const trace = container.querySelector('[data-testid="trace-view"]') as HTMLElement;
    const prompt = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;

    expect(workbenchTab.getAttribute('aria-selected')).toBe('true');
    expect(traceTab.getAttribute('aria-selected')).toBe('false');
    expect(workbench.hidden).toBe(false);
    expect(trace.hidden).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(prompt, 'Keep this draft');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(prompt.value).toBe('Keep this draft');
    await act(async () => traceTab.click());

    expect(traceTab.getAttribute('aria-selected')).toBe('true');
    expect(workbench.hidden).toBe(true);
    expect(trace.hidden).toBe(false);
    expect(trace.textContent).toContain('epoch-1');

    await act(async () => workbenchTab.click());
    expect((container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });

  it('uses one tab stop and standard arrow, Home, and End navigation for observatory views', async () => {
    const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{}} />);
    const workbench = tab(container, 'Workbench');
    const trace = tab(container, 'Trace');

    expect(workbench.tabIndex).toBe(0);
    expect(trace.tabIndex).toBe(-1);

    workbench.focus();
    await act(async () => workbench.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(trace.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(trace);
    expect(workbench.tabIndex).toBe(-1);
    expect(trace.tabIndex).toBe(0);

    await act(async () => trace.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(document.activeElement).toBe(workbench);
    await act(async () => workbench.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement).toBe(trace);
    await act(async () => trace.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(workbench);
  });

  it('keeps pending interaction actions in the Workbench directly before the composer', async () => {
    const respondToInteraction = vi.fn();
    const state = {
      ...replicaState,
      pendingInteractions: [{
        kind: 'plan_approval' as const,
        requestId: 'plan-1',
        plan: 'Inspect the provider trace.',
        allowedActions: ['approve' as const, 'reject' as const],
      }],
    };
    const container = await render(<App
      initialState={state}
      initialSessionStatus="ready"
      actions={{ respondToInteraction, sendMessage: vi.fn() }}
    />);
    const workbench = container.querySelector('[data-testid="workbench"]') as HTMLElement;
    const interaction = workbench.querySelector('.agent-plan') as HTMLElement;
    const composer = workbench.querySelector('[aria-label="Live provider controls"]') as HTMLElement;

    expect(interaction).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(interaction.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    await act(async () => (interaction.querySelector('[data-action="approve"]') as HTMLButtonElement).click());
    expect(respondToInteraction).toHaveBeenCalledWith('plan-1', { kind: 'plan_approval', action: 'approve' });
  });

  it('keeps desktop Context available and opens Inspector without remounting the conversation', async () => {
    const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{}} />);
    expect(container.querySelector('#lab-context')?.getAttribute('role')).toBeNull();
    const composer = container.querySelector('textarea');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
    const toggle = container.querySelector('[aria-controls="lab-inspector"]') as HTMLInputElement;
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(false);
    expect((container.querySelector('#lab-inspector') as HTMLElement).hidden).toBe(true);
    await act(async () => toggle.click());
    expect((container.querySelector('#lab-inspector') as HTMLElement).hidden).toBe(false);
    expect(container.querySelector('#lab-inspector')?.getAttribute('role')).toBeNull();
    expect(container.querySelector('textarea')).toBe(composer);
    await act(async () => toggle.click());
    expect((container.querySelector('#lab-inspector') as HTMLElement).hidden).toBe(true);
  });

  it('opens Context as the first task surface on a compact layout without an Agent', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = compactMatchMedia;
    try {
      const container = await render(<App transport={labTransport()} />);
      expect(container.querySelector('#lab-context')?.getAttribute('role')).toBe('dialog');
      expect(container.querySelector('#lab-inspector')).toBeNull();
      expect(document.activeElement?.textContent).toBe('Close Context');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('treats the compact Inspector as a keyboard-contained sheet that restores its trigger', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = compactMatchMedia;
    try {
      const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{}} />);
      const toggle = container.querySelector('[aria-label="View options"]') as HTMLButtonElement;

      toggle.focus();
      await act(async () => toggle.click());
      await act(async () => container.querySelector<HTMLInputElement>('[aria-controls="lab-inspector"]')!.click());
      const inspector = container.querySelector('#lab-inspector') as HTMLElement;
      expect(inspector.getAttribute('role')).toBe('dialog');
      expect(inspector.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement?.textContent).toBe('Close Replica Inspector');
      expect(container.querySelector('#lab-context')).toBeNull();
      expect(container.querySelector('.lab-main-stage')?.hasAttribute('inert')).toBe(true);
      expect(container.querySelector('.lab-view-switcher')?.hasAttribute('inert')).toBe(true);

      await act(async () => inspector.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(container.querySelector('#lab-inspector')).toBeNull();
      expect(document.activeElement).toBe(toggle);
      expect(container.querySelector('.lab-main-stage')?.hasAttribute('inert')).toBe(false);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('closes compact Context and focuses the Timeline when an Agent attach begins', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = compactMatchMedia;
    try {
      const container = await render(<App transport={labTransport()} />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => (container.querySelector('[data-testid="session-create"]') as HTMLButtonElement).click());

      expect(container.querySelector('#lab-context')).toBeNull();
      expect(document.activeElement).toBe(container.querySelector('[data-testid="workbench"]'));
      expect(container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('Connecting');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('traces projected entries without claiming Provider-native frames', async () => {
    const state = {
      ...replicaState,
      timeline: {
        ...replicaState.timeline,
        entries: [{
          providerId: 'recorded', seqStart: 6, seqEnd: 6,
          timestamp: '2026-09-02T00:00:05.000Z',
          sourceSeqRanges: [{ startSeq: 6, endSeq: 6 }], collapsed: [],
          item: { type: 'assistant_message' as const, text: 'Visible tail.', messageId: 'tail' },
          resources: [],
        }],
      },
      diagnostics: [{ code: 'timeline_recovery_failed', message: 'Timeline recovery failed.', recoverable: true }],
    };
    const container = await render(<App initialState={state} initialSessionStatus="ready" actions={{}} />);

    await act(async () => tab(container, 'Trace').click());
    const trace = container.querySelector('[data-testid="trace-view"]') as HTMLElement;

    expect(trace.textContent).toContain('#6');
    expect(trace.textContent).toContain('Assistant message');
    expect(trace.textContent).toContain('Provider-native and raw wire frames are not retained');
  });

  it('identifies a reattached Agent from its Snapshot when no local Provider label is remembered', async () => {
    const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{}} />);
    const summary = container.querySelector('[data-testid="connection-summary"]') as HTMLElement;

    expect(summary.textContent).toContain('recorded');
    expect(summary.textContent).not.toContain('No active Agent');
  });

  it('clears the previous replica as soon as a resumed Agent is attached', async () => {
    const replacement = deferred<AgentSessionResponse>();
    const transport = labTransport({ resumeAgent: vi.fn(() => replacement.promise) });
    const previousAgent = replicaState.agent;
    if (!previousAgent) throw new Error('The App fixture requires an Agent Snapshot.');
    const previousState = {
      ...replicaState,
      agent: {
        ...previousAgent,
        persistence: { providerId: 'recorded', sessionId: 'old-session', opaque: 'old-handle' },
      },
    };
    const container = await render(<App
      initialState={previousState}
      initialSessionStatus="ready"
      transport={transport}
    />);

    await act(async () => {
      (container.querySelector('[data-testid="session-resume"]') as HTMLButtonElement).click();
      replacement.resolve(sessionResponse('replacement-agent'));
      await replacement.promise;
    });

    expect(transport.resumeAgent).toHaveBeenCalledWith(expect.any(String), previousState.agent.persistence);
    expect(container.querySelector('[data-testid="connection-summary"]')?.textContent).toContain('No active Agent');
    expect((container.querySelector('.lab-composer-dock') as HTMLElement).hidden).toBe(true);
    expect(container.querySelector('[data-testid="connection-status"]')?.textContent).toBe('Connecting');
  });

  it('starts only one Agent transition when the create control is activated twice before rerender', async () => {
    const creation = deferred<AgentSessionResponse>();
    const createAgent = vi.fn(() => creation.promise);
    const transport = labTransport({ createAgent });
    const container = await render(<App transport={transport} />);
    await act(async () => { await Promise.resolve(); });
    const create = container.querySelector('[data-testid="session-create"]') as HTMLButtonElement;

    await act(async () => {
      create.click();
      create.click();
    });

    expect(createAgent).toHaveBeenCalledOnce();
  });

  it('reattaches a remembered Agent when the injected transport changes', async () => {
    const connectFirst = vi.fn(() => ({ send: () => undefined, close: () => undefined }));
    const connectSecond = vi.fn(() => ({ send: () => undefined, close: () => undefined }));
    const first = labTransport({ connect: connectFirst });
    const second = labTransport({ connect: connectSecond });
    window.history.replaceState(null, '', '/?agent=remembered-agent');
    try {
      function Harness() {
        const [useSecond, setUseSecond] = useState(false);
        return <>
          <button type="button" onClick={() => setUseSecond(true)}>Switch transport</button>
          <App transport={useSecond ? second : first} />
        </>;
      }
      const container = await render(<Harness />);
      expect(connectFirst).toHaveBeenCalledOnce();

      await act(async () => (container.querySelector('button') as HTMLButtonElement).click());

      expect(connectSecond).toHaveBeenCalledOnce();
      expect(connectSecond).toHaveBeenCalledWith('remembered-agent', expect.any(Object));
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

function tab(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`${label} tab was not rendered.`);
  return match;
}

function compactMatchMedia(query: string): MediaQueryList {
  return {
    matches: query === '(max-width: 1180px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

function labTransport(overrides: Partial<LabTransport> = {}): LabTransport {
  return {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded semantic Provider' }],
    createAgent: async () => sessionResponse('created-agent'),
    resumeAgent: async () => sessionResponse('resumed-agent'),
    fetchSnapshot: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      type: 'agent_snapshot',
      payload: replicaState.agent!,
    }),
    fetchTimeline: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      type: 'timeline_page',
      payload: {
        requestId: 'timeline-request', agentId: 'agent-1', epoch: 'epoch-1', direction: 'tail',
        reset: false, staleCursor: false, gap: false,
        window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null,
        entries: [], hasOlder: false, hasNewer: false, error: null,
      },
    }),
    connect: (_agentId: string, _listener: RemoteTransportListener) => ({ send: () => undefined, close: () => undefined }),
    onDiagnostic: () => () => undefined,
    onProtocolMessage: () => () => undefined,
    ...overrides,
  };
}

function sessionResponse(agentId: string): AgentSessionResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'agent_session',
    payload: {
      requestId: `request-${agentId}`,
      agentId,
      providerId: 'recorded',
      sessionId: `session-${agentId}`,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}


it('shows recovery waiting without a failure alert and clears it after a successful retry', async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '/?host=desk&agent=stale&provider=codex&session=native');
  const request = vi.fn().mockResolvedValueOnce(Response.json({ code: 'session_attach_timeout', error: 'Timeout', requestId: 'rpc-1' }, { status: 504 }))
    .mockResolvedValue(Response.json({ agentId: 'restored', nativeSessionId: 'native' }));
  vi.stubGlobal('fetch', request);
  const connect = vi.fn(() => ({ send: () => undefined, close: () => undefined }));
  try {
    const container = await render(<App transport={labTransport({ connect })} />);
    expect(container.querySelector('.lab-session-notice [role="status"]')?.textContent).toContain('may still be opening');
    expect(container.querySelector('.lab-session-notice [role="alert"]')).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(connect).toHaveBeenCalledWith('restored', expect.any(Object));
    expect(container.querySelector('.lab-session-notice')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});


it('notifies a failed send without clearing the draft or replaying it after dismissal', async () => {
  const sendMessage = vi.fn(async () => { throw new Error('The message was not accepted.'); });
  const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{ sendMessage }} />);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this failed message');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(container.querySelector('.lab-toast')?.textContent).toContain('The message was not accepted.');
  await act(async () => container.querySelector<HTMLButtonElement>('.lab-toast button')!.click());
  expect(input.value).toBe('Keep this failed message');
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The message was not accepted.');
});
