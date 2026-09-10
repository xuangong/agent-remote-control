import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
  ProjectedTimelineEntry,
} from '@borgee/agent-remote-protocol';

import { applyResourceUpdate, createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';

function entry(
  seq: number,
  item: ProjectedTimelineEntry['item'],
  resources: ProjectedTimelineEntry['resources'] = [],
  providerId = 'provider-neutral',
): ProjectedTimelineEntry {
  return {
    providerId, item, resources,
    timestamp: `2026-09-02T00:00:0${seq}.000Z`,
    seqStart: seq, seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [],
  };
}

function state(
  entries: ProjectedTimelineEntry[],
  pendingInteractions: AgentInteractionRequest[] = [],
  epoch = 'epoch-one',
): AgentReplicaState {
  return {
    ...createReplicaState(),
    timeline: {
      epoch, initialized: true, entries,
      nextSeq: entries.at(-1)?.seqEnd ? (entries.at(-1)?.seqEnd ?? 0) + 1 : 1,
      hasOlder: false, pendingLive: [],
    },
    pendingInteractions,
  };
}

describe('AgentTimeline', () => {
  it('replaces the actionable request with one completed history item when the Replica resolves it', async () => {
    const request: AgentInteractionRequest = { kind: 'plan_approval', requestId: 'plan-history', plan: 'Inspect once', allowedActions: ['approve'] };
    const response: AgentInteractionResponse = { kind: 'plan_approval', action: 'approve' };
    const container = await render(<AgentTimeline state={state([], [request])} onInteractionResponse={async () => undefined} />);
    expect(container.querySelectorAll('.agent-interactions .agent-plan')).toHaveLength(1);
    expect(container.querySelector('.agent-interaction-completed')).toBeNull();
    await rerender(container, <AgentTimeline state={state([entry(1, { type: 'interaction', request, response })])} onInteractionResponse={async () => undefined} />);
    expect(container.querySelector('.agent-interactions')).toBeNull();
    expect(container.querySelectorAll('.agent-interaction-completed')).toHaveLength(1);
    expect(container.textContent).toContain('Inspect once');
    expect(container.querySelector('[data-entry-key]')?.getAttribute('data-entry-key')).toBe('epoch-one:provider-neutral:1:plan-history');
  });

  it('keeps a host-hidden header out of the conversation without removing entries', async () => {
    const content = state([entry(1, { type: 'assistant_message', messageId: 'answer', text: 'The answer' })]);
    const container = await render(<AgentTimeline state={content} />);
    expect(container.querySelector('.agent-surface-header')).not.toBeNull();

    await rerender(container, <AgentTimeline state={content} showHeader={false} />);

    expect(container.querySelector('.agent-surface-header')).toBeNull();
    expect(container.querySelector('[data-entry-key="epoch-one:provider-neutral:1:answer"]')?.textContent).toContain('The answer');
  });

  it('waits for earlier history and suppresses repeated activation before rendering pending state', async () => {
    const history = deferred<void>();
    let calls = 0;
    const initial = state([entry(5, { type: 'assistant_message', text: 'Recent answer' })]);
    const withHistory = { ...initial, timeline: { ...initial.timeline, hasOlder: true } };
    const container = await render(<AgentTimeline state={withHistory} onLoadOlder={() => { calls += 1; return history.promise; }} />);
    const button = container.querySelector<HTMLButtonElement>('.agent-load-older')!;

    await act(async () => { button.click(); button.click(); });

    expect(calls).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Loading');
    await act(async () => { history.resolve(); await history.promise; });
    expect(button.disabled).toBe(false);
  });

  it('shows failed history loading and permits a successful retry', async () => {
    const history = deferred<void>();
    let calls = 0;
    const initial = state([entry(5, { type: 'assistant_message', text: 'Recent answer' })]);
    const withHistory = { ...initial, timeline: { ...initial.timeline, hasOlder: true } };
    const container = await render(<AgentTimeline state={withHistory} onLoadOlder={() => {
      calls += 1;
      return calls === 1 ? history.promise : Promise.resolve();
    }} />);
    const button = container.querySelector<HTMLButtonElement>('.agent-load-older')!;
    await act(async () => button.click());
    await act(async () => { history.reject(new Error('History is unavailable.')); await history.promise.catch(() => undefined); });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('History is unavailable.');
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(calls).toBe(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('starts fresh history loading after an epoch replacement without accepting stale errors', async () => {
    const previous = deferred<void>();
    const current = deferred<void>();
    const initial = state([entry(5, { type: 'assistant_message', text: 'Recent answer' })]);
    const withHistory = { ...initial, timeline: { ...initial.timeline, hasOlder: true } };
    const container = await render(<AgentTimeline state={withHistory} onLoadOlder={() => previous.promise} />);
    await act(async () => container.querySelector<HTMLButtonElement>('.agent-load-older')?.click());
    await rerender(container, <AgentTimeline
      state={{ ...withHistory, timeline: { ...withHistory.timeline, epoch: 'replacement' } }}
      onLoadOlder={() => current.promise}
    />);
    const button = container.querySelector<HTMLButtonElement>('.agent-load-older')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    await act(async () => { previous.reject(new Error('Stale history failure.')); await previous.promise.catch(() => undefined); });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button.disabled).toBe(true);
    await act(async () => { current.resolve(); await current.promise; });
    expect(button.disabled).toBe(false);
  });

  it('renders string Markdown for user, assistant, and collapsible reasoning entries', async () => {
    const container = await render(<AgentTimeline state={state([
      entry(1, { type: 'user_message', text: 'Use **strict** protocol values.' }, [], 'provider-any'),
      entry(2, { type: 'assistant_message', text: 'See [the report](https://example.test/report).' }),
      entry(3, { type: 'reasoning', text: 'Inspect `sequence` before apply.' }),
    ])} />);

    expect(container.querySelector('.agent-message-user strong')?.textContent).toBe('strict');
    expect(container.querySelector('.agent-message-assistant a')?.getAttribute('href')).toBe('https://example.test/report');
    const reasoning = container.querySelector<HTMLButtonElement>('.agent-reasoning-toggle');
    expect(reasoning?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Inspect sequence before apply.');
    await act(async () => reasoning?.click());
    expect(container.querySelector('.agent-reasoning-content code')?.textContent).toBe('sequence');
  });

  it('preserves entry component state when an incremental projection extends its sequence range', async () => {
    const initial = entry(1, { type: 'reasoning', text: 'First fragment.' });
    const container = await render(<AgentTimeline state={state([initial])} />);
    const toggle = container.querySelector<HTMLButtonElement>('.agent-reasoning-toggle');
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    const extended = {
      ...initial,
      seqEnd: 2,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      item: { type: 'reasoning' as const, text: 'First fragment. Second fragment.' },
    };
    await rerender(container, <AgentTimeline state={state([extended])} />);

    expect(container.querySelector('.agent-reasoning-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.agent-reasoning-content')?.textContent).toContain('Second fragment.');
  });

  it('remounts a stateful timeline item when replacement begins a new epoch', async () => {
    const epochA = entry(1, { type: 'reasoning', text: 'Epoch A reasoning' });
    const container = await render(<AgentTimeline state={state([epochA], [], 'epoch-a')} />);
    const toggle = container.querySelector<HTMLButtonElement>('.agent-reasoning-toggle');
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    const epochB = { ...epochA, item: { type: 'reasoning' as const, text: 'Epoch B replacement reasoning' } };
    await rerender(container, <AgentTimeline state={state([epochB], [], 'epoch-b')} />);

    const replacementToggle = container.querySelector<HTMLButtonElement>('.agent-reasoning-toggle');
    expect(replacementToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Epoch A reasoning');
    await act(async () => replacementToggle?.click());
    expect(container.querySelector('.agent-reasoning-content')?.textContent).toContain('Epoch B replacement reasoning');
  });

  it('groups consecutive messages by sender without grouping across another timeline item', async () => {
    const container = await render(<AgentTimeline state={state([
      entry(1, { type: 'assistant_message', messageId: 'answer-one', text: 'First answer' }),
      entry(2, { type: 'assistant_message', messageId: 'answer-two', text: 'Second answer' }),
      entry(3, { type: 'reasoning', text: 'A separate timeline item' }),
      entry(4, { type: 'assistant_message', messageId: 'answer-three', text: 'Third answer' }),
      entry(5, { type: 'user_message', messageId: 'prompt-one', text: 'First prompt' }),
      entry(6, { type: 'user_message', messageId: 'prompt-two', text: 'Second prompt' }),
    ])} />);

    const messages = [...container.querySelectorAll<HTMLElement>('[data-message-group]')];
    expect(messages.map((message) => message.dataset.messageGroup)).toEqual([
      'first', 'last', 'single', 'first', 'last',
    ]);
    expect(messages.map((message) => message.textContent)).toEqual([
      'AssistantFirst answer', 'AssistantSecond answer', 'AssistantThird answer',
      'YouFirst prompt', 'YouSecond prompt',
    ]);
  });

  it('renders incremental tool and todo states with text status, not color alone', async () => {
    const container = await render(<AgentTimeline state={state([
      entry(1, {
        type: 'tool_call', callId: 'call-one', name: 'read', status: 'running', error: null,
        detail: { type: 'read', filePath: '/workspace/AGENTS.md' },
      }),
      entry(2, {
        type: 'tool_call', callId: 'call-two', name: 'shell', status: 'failed', error: 'Exit 2',
        detail: { type: 'shell', command: 'pnpm test', cwd: '/workspace' },
      }),
      entry(3, { type: 'todo', items: [
        { text: 'Read protocol', completed: true, status: 'completed' },
        { text: 'Render interactions', completed: false, status: 'in_progress', activeForm: 'Rendering interactions' },
      ] }),
    ])} />);

    expect(container.textContent).toContain('Running');
    expect(container.textContent).toContain('/workspace/AGENTS.md');
    expect(container.textContent).toContain('Failed');
    expect(container.textContent).toContain('Exit 2');
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('In progress');
  });

  it('submits a closed question response from labelled native controls', async () => {
    const request: AgentInteractionRequest = {
      kind: 'question', requestId: 'question-one', questions: [{
        questionId: 'runtime', header: 'Runtime', prompt: 'Choose runtimes', required: true,
        selection: 'multiple',
        options: [{ value: 'web', label: 'Web' }, { value: 'cli', label: 'CLI' }],
        allowCustomText: true, allowDismiss: false,
      }],
    };
    const responses: Array<{ requestId: string; response: AgentInteractionResponse }> = [];
    const container = await render(<AgentTimeline
      state={state([], [request])}
      onInteractionResponse={(requestId, response) => responses.push({ requestId, response })}
    />);

    const web = container.querySelector<HTMLInputElement>('input[value="web"]');
    const custom = container.querySelector<HTMLInputElement>('input[name="runtime-custom"]');
    await act(async () => web?.click());
    await act(async () => {
      if (custom) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, 'desktop');
        custom.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });

    expect(responses).toEqual([{
      requestId: 'question-one',
      response: {
        kind: 'question',
        answers: [{ questionId: 'runtime', selectedValues: ['web'], customText: 'desktop' }],
      },
    }]);
  });

  it('locks question answers while submitting and retains them after a rejected response', async () => {
    const confirmation = deferred<void>();
    const responses: AgentInteractionResponse[] = [];
    const request: AgentInteractionRequest = {
      kind: 'question', requestId: 'question-retry', questions: [{
        questionId: 'runtime', header: 'Runtime', prompt: 'Choose a runtime', required: true,
        selection: 'single', options: [{ value: 'web', label: 'Web' }, { value: 'cli', label: 'CLI' }],
        allowCustomText: true, allowDismiss: false,
      }],
    };
    const container = await render(<AgentTimeline state={state([], [request])} onInteractionResponse={(_, response) => {
      responses.push(response);
      return responses.length === 1 ? confirmation.promise : Promise.resolve();
    }} />);
    const web = container.querySelector<HTMLInputElement>('input[value="web"]')!;
    const custom = container.querySelector<HTMLInputElement>('input[name="runtime-custom"]')!;
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => web.click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, 'desktop');
      custom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => submit.click());

    expect(web.matches(':disabled')).toBe(true);
    expect(custom.matches(':disabled')).toBe(true);
    expect(submit.textContent).toContain('Submitting');
    await act(async () => { confirmation.reject(new Error('Please retry.')); await confirmation.promise.catch(() => undefined); });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please retry.');
    expect(web.matches(':disabled')).toBe(false);
    expect(web.checked).toBe(true);
    expect(custom.value).toBe('desktop');
    await act(async () => submit.click());
    expect(responses).toEqual([
      { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['web'], customText: 'desktop' }] },
      { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['web'], customText: 'desktop' }] },
    ]);
  });

  it('exposes only the allowed plan and tool approval actions', async () => {
    const requests: AgentInteractionRequest[] = [{
      kind: 'plan_approval', requestId: 'plan-one',
      plan: '1. **Inspect** the protocol\n2. Run tests',
      allowedActions: ['approve_and_resume', 'reject'],
    }, {
      kind: 'tool_approval', requestId: 'tool-one', toolCallId: 'call-one',
      toolName: 'shell', summary: 'Run the test suite',
      detail: { type: 'shell', command: 'pnpm test' },
      allowedDecisions: ['allow', 'deny'], allowScopes: ['once', 'session'],
    }];
    const responses: Array<{ requestId: string; response: AgentInteractionResponse }> = [];
    const container = await render(<AgentTimeline
      state={state([], requests)}
      onInteractionResponse={(requestId, response) => responses.push({ requestId, response })}
    />);

    expect(container.querySelector('.agent-plan strong')?.textContent).toBe('Inspect');
    expect(container.querySelector('button[data-action="approve"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-action="approve_and_resume"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-decision="allow"][data-scope="session"]')?.click());

    expect(responses).toEqual([
      { requestId: 'plan-one', response: { kind: 'plan_approval', action: 'approve_and_resume' } },
      { requestId: 'tool-one', response: { kind: 'tool_approval', decision: 'allow', scope: 'session' } },
    ]);
  });

  it('keeps a recognized interaction visible and non-actionable when the host has no response handler', async () => {
    const request: AgentInteractionRequest = {
      kind: 'plan_approval', requestId: 'plan-without-host', plan: 'Approve the plan',
      allowedActions: ['approve'],
    };
    const container = await render(<AgentTimeline state={state([], [request])} />);

    const alert = container.querySelector('[role="status"]');
    expect(alert?.textContent).toContain('Interaction unavailable');
    expect(alert?.textContent).toContain('plan approval');
    expect(alert?.querySelector('button')).toBeNull();
  });

  it('marks a tool approval with allow but no declared scope as invalid and non-actionable', async () => {
    const request: AgentInteractionRequest = {
      kind: 'tool_approval', requestId: 'tool-without-scope', toolCallId: 'call-one',
      toolName: 'shell', summary: 'Run the test suite', detail: { type: 'shell', command: 'pnpm test' },
      allowedDecisions: ['allow', 'deny'], allowScopes: [],
    };
    const responses: AgentInteractionResponse[] = [];
    const container = await render(<AgentTimeline
      state={state([], [request])}
      onInteractionResponse={(_requestId, response) => responses.push(response)}
    />);

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Invalid interaction request');
    expect(alert?.textContent).toContain('no approval scope');
    expect(container.querySelector('[data-decision]')).toBeNull();
    expect(responses).toEqual([]);
  });

  it('requests bytes only after pushed available metadata and leaves terminal failures non-actionable', async () => {
    const resources = [
      { locator: '/tmp/pending.png', resourceId: 'pending', status: 'pending' as const },
      { locator: '/tmp/ready.png', resourceId: 'ready', status: 'available' as const },
      { locator: '/tmp/failed.png', resourceId: 'failed', status: 'failed' as const },
      { locator: '/tmp/missing.png', resourceId: 'missing', status: 'unavailable' as const },
    ];
    const requests: string[] = [];
    const resourceState: AgentReplicaState = {
      ...state([entry(1, { type: 'assistant_message', text: 'Generated files' }, resources)]),
      resources: {
        pending: { status: 'pending', retryAfterMs: 100 },
        ready: { status: 'available', mediaType: 'image/png', byteLength: 42, sha256: 'digest' },
        failed: { status: 'failed', message: 'Provider read failed', retryable: true },
        missing: { status: 'unavailable', reason: 'Resource was retired' },
      },
    };
    const container = await render(<AgentTimeline
      state={resourceState}
      onResourceRequest={({ resourceId }) => requests.push(resourceId)}
    />);

    for (const label of ['Pending', 'Available', 'Failed', 'Unavailable']) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain('Provider read failed');
    expect(container.textContent).toContain('Resource was retired');
    expect(container.querySelector('button[data-resource-id="pending"]')).toBeNull();
    expect(container.querySelector('button[data-resource-id="failed"]')).toBeNull();
    expect(container.querySelector('button[data-resource-id="missing"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-resource-id="ready"]')?.click());
    expect(requests).toEqual(['ready']);
  });

  it('renders pushed available metadata as an authorized resource request action', async () => {
    const binding = { locator: 'output.png', resourceId: 'resource-one', status: 'pending' as const };
    const requests: string[] = [];
    const updated = applyResourceUpdate(
      state([entry(1, { type: 'assistant_message', text: 'Generated output' }, [binding])]),
      {
        protocolVersion: '1.4.0',
        type: 'resource_update',
        payload: {
          agentId: 'agent-one', resourceId: binding.resourceId,
          state: { status: 'available', mediaType: 'image/png', byteLength: 42, sha256: 'canonical-digest' },
        },
      },
    );
    const container = await render(<AgentTimeline
      state={updated}
      onResourceRequest={({ resourceId }) => requests.push(resourceId)}
    />);

    expect(container.textContent).toContain('Available');
    expect(container.textContent).toContain('image/png · 42 bytes');
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-resource-id="resource-one"]')?.click());
    expect(requests).toEqual(['resource-one']);
  });

  it('materializes authorized resource response bytes as open and download actions', async () => {
    const binding = { locator: 'reports/output image.png', resourceId: 'resource-loaded', status: 'available' as const };
    const resourceState: AgentReplicaState = {
      ...state([entry(1, { type: 'assistant_message', text: 'Generated output' }, [binding])]),
      resources: {
        [binding.resourceId]: {
          status: 'available', mediaType: 'image/png', byteLength: 4,
          sha256: 'canonical-digest', contentBase64: 'AAAA',
        },
      },
    };
    const container = await render(<AgentTimeline state={resourceState} />);

    const open = container.querySelector<HTMLAnchorElement>('a[data-resource-open="resource-loaded"]');
    const download = container.querySelector<HTMLAnchorElement>('a[data-resource-download="resource-loaded"]');
    expect(open?.href).toBe('data:image/png;base64,AAAA');
    expect(open?.target).toBe('_blank');
    expect(download?.href).toBe('data:image/png;base64,AAAA');
    expect(download?.download).toBe('output image.png');
    expect(container.querySelector('button[data-resource-id="resource-loaded"]')).toBeNull();
  });

  it('offers active HTML, SVG, and XHTML resources as downloads without an open link', async () => {
    const html = { locator: 'reports/result.html', resourceId: 'active-html', status: 'available' as const };
    const svg = { locator: 'reports/chart.svg', resourceId: 'active-svg', status: 'available' as const };
    const xhtml = { locator: 'reports/detail.xhtml', resourceId: 'active-xhtml', status: 'available' as const };
    const resourceState: AgentReplicaState = {
      ...state([entry(1, { type: 'assistant_message', text: 'Generated output' }, [html, svg, xhtml])]),
      resources: {
        [html.resourceId]: {
          status: 'available', mediaType: 'text/html', byteLength: 4,
          sha256: 'html-digest', contentBase64: 'PGgxPg==',
        },
        [svg.resourceId]: {
          status: 'available', mediaType: 'image/svg+xml', byteLength: 4,
          sha256: 'svg-digest', contentBase64: 'PHN2Zw==',
        },
        [xhtml.resourceId]: {
          status: 'available', mediaType: 'application/xhtml+xml', byteLength: 6,
          sha256: 'xhtml-digest', contentBase64: 'PGh0bWw+',
        },
      },
    };
    const container = await render(<AgentTimeline state={resourceState} />);

    expect(container.querySelector('a[data-resource-open="active-html"]')).toBeNull();
    expect(container.querySelector('a[data-resource-open="active-svg"]')).toBeNull();
    expect(container.querySelector('a[data-resource-open="active-xhtml"]')).toBeNull();
    expect(container.querySelector<HTMLAnchorElement>('a[data-resource-download="active-html"]')?.href)
      .toBe('data:text/html;base64,PGgxPg==');
    expect(container.querySelector<HTMLAnchorElement>('a[data-resource-download="active-html"]')?.download).toBe('result.html');
    expect(container.querySelector<HTMLAnchorElement>('a[data-resource-download="active-svg"]')?.href)
      .toBe('data:image/svg+xml;base64,PHN2Zw==');
    expect(container.querySelector<HTMLAnchorElement>('a[data-resource-download="active-svg"]')?.download).toBe('chart.svg');
    expect(container.querySelector<HTMLAnchorElement>('a[data-resource-download="active-xhtml"]')?.href)
      .toBe('data:application/xhtml+xml;base64,PGh0bWw+');
    expect(container.querySelector<HTMLAnchorElement>('a[data-resource-download="active-xhtml"]')?.download).toBe('detail.xhtml');
  });

  it('keeps an interaction pending and reports a rejected response confirmation', async () => {
    const request: AgentInteractionRequest = {
      kind: 'plan_approval', requestId: 'plan-rejected', plan: 'Approve the plan', allowedActions: ['approve'],
    };
    const container = await render(<AgentTimeline
      state={state([], [request])}
      onInteractionResponse={() => Promise.reject(new Error('Interaction response was rejected.'))}
    />);

    await act(async () => (container.querySelector('[data-action="approve"]') as HTMLButtonElement).click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Interaction response was rejected.');
    expect(container.querySelector('[data-action="approve"]')).not.toBeNull();
  });

  it('reports a rejected resource confirmation without claiming the resource was loaded', async () => {
    const binding = { locator: 'output.png', resourceId: 'resource-rejected', status: 'available' as const };
    const resourceState: AgentReplicaState = {
      ...state([entry(1, { type: 'assistant_message', text: 'Generated output' }, [binding])]),
      resources: {
        [binding.resourceId]: { status: 'available', mediaType: 'image/png', byteLength: 42, sha256: 'digest' },
      },
    };
    const container = await render(<AgentTimeline
      state={resourceState}
      onResourceRequest={() => Promise.reject(new Error('Resource request was rejected.'))}
    />);

    await act(async () => (container.querySelector('[data-resource-id="resource-rejected"]') as HTMLButtonElement).click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Resource request was rejected.');
    expect(container.textContent).not.toContain('Resource loaded');
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  void promise.catch(() => undefined);
  return { promise, resolve: (value) => resolve(value as T), reject };
}
