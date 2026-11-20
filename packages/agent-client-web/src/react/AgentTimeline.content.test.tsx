// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { render, rerender } from '../test/setup.js';
import { openReceipts, showChanges } from '../test/interactions.js';
import { AgentTimeline } from './AgentTimeline.js';
import { createReplicaState, type ProcessMode } from '@orchardworks/agent-client';

const items: AgentTimelineItem[] = [
  { type: 'user_message', text: 'Please **fix** this.' },
  { type: 'reasoning', text: 'Internal reasoning' },
  { type: 'assistant_message', messageId: 'progress', text: 'Checking the report.' },
  { type: 'tool_call', callId: 'test', name: 'shell', status: 'completed', error: null,
    detail: { type: 'shell', command: 'pnpm test' }, result: { content: [{ type: 'text', text: 'Tool output' }] } },
  { type: 'todo', items: [{ text: 'Internal task', completed: true }] },
  { type: 'error', message: 'Runtime notice' },
  { type: 'compaction', status: 'completed', trigger: 'auto' },
  { type: 'interaction', request: { kind: 'plan_approval', requestId: 'old-plan', plan: 'Historical plan', allowedActions: ['approve'] },
    response: { kind: 'plan_approval', action: 'approve' } },
  { type: 'assistant_message', messageId: 'summary', text: '## Summary\n\nFixed [details](https://example.com).' },
];

function state(content = items) {
  const base = createReplicaState();
  return { ...base, timeline: { ...base.timeline, epoch: 'epoch', initialized: true, entries: content.map((item, index) => ({
    providerId: 'test', item, timestamp: '2026-09-18T00:00:00Z', seqStart: index + 1, seqEnd: index + 1,
    sourceSeqRanges: [], collapsed: [], resources: [],
  })) } };
}

describe('the conversation in Concise: messages and decisions, the work behind its line', () => {
  it('updates task completion and plan tool status while preserving answered questions and approval decisions', async () => {
    const request = { kind: 'question' as const, requestId: 'requirements', questions: [{
      questionId: 'platform', header: 'Platform', prompt: 'Which platform?', selection: 'single' as const, required: true,
      options: [{ value: 'mobile', label: 'Mobile' }], allowCustomText: false, allowDismiss: false,
    }] };
    const content: AgentTimelineItem[] = [
      { type: 'todo', items: [{ id: 'test', text: 'Validate the change', completed: false, status: 'in_progress' }] },
      { type: 'tool_call', callId: 'plan', name: 'functions.update_plan', status: 'running', error: null,
        detail: { type: 'other', description: 'Update the implementation plan' } },
      { type: 'interaction', request, response: { kind: 'question', answers: [{ questionId: 'platform', selectedValues: ['mobile'] }] } },
      { type: 'interaction', request: { kind: 'plan_approval', requestId: 'plan-review', plan: 'Test on mobile.', allowedActions: ['reject'] },
        response: { kind: 'plan_approval', action: 'reject', feedback: 'Include desktop too.' } },
      { type: 'interaction', request: { kind: 'tool_approval', requestId: 'command-review', toolCallId: 'command', toolName: 'shell',
        summary: 'Run validation', detail: { type: 'shell', command: 'pnpm test' }, allowedDecisions: ['deny'], allowScopes: [] },
        response: { kind: 'tool_approval', decision: 'deny', message: 'Wait for review.' } },
    ];
    const view = (entries: AgentTimelineItem[]) => <AgentTimeline processMode="full" state={state(entries)} />;
    const container = await render(view(content));
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(5);
    expect(container.querySelector('.agent-todo')?.textContent).toContain('In progress');
    expect(container.querySelector('.agent-tool')?.textContent).toContain('Running');
    expect(container.querySelector('.agent-tool-approval-completed .agent-receipt-toggle')?.textContent).toContain('Not allowed');
    await openReceipts(container);
    expect(container.querySelector('.agent-question-completed')?.textContent).toContain('Mobile');
    expect(container.querySelector('.agent-question-completed')?.textContent).toContain('Which platform?');
    expect(container.querySelector('.agent-plan-completed')?.textContent).toContain('Include desktop too.');
    expect(container.querySelector('.agent-tool-approval-completed')?.textContent).toContain('Wait for review.');
    const task = container.querySelector('.agent-todo');
    const tool = content[1] as Extract<AgentTimelineItem, { type: 'tool_call' }>;
    await rerender(container, view([
      { type: 'todo', items: [{ id: 'test', text: 'Validate the change', completed: true, status: 'completed' }] },
      { ...tool, status: 'completed' }, ...content.slice(2),
    ]));
    expect(container.querySelector('.agent-todo')).toBe(task);
    expect(task?.textContent).toContain('Completed');
    expect(task?.textContent).not.toContain('In progress');
    expect(container.querySelector('.agent-tool')?.textContent).toContain('Completed');
  });

  it.each(['./summary.png', 'codex-image:generated', 'claude-image:tool', 'opencode-image:output', 'dsh-attachment:picture', 'another-agent:picture'])('renders bound Markdown image %s in its bubble without a second resource card', async locator => {
    const binding = { locator, resourceId: 'summary-image', status: 'available' as const };
    const current = state([{ type: 'assistant_message', text: `![Summary diagram](${locator})` }]);
    const container = await render(<AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map(entry => ({ ...entry, resources: [binding] })) },
        resources: { 'summary-image': { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'image', contentBase64: 'AA==', imageDimensions: { width: 640, height: 480 } } } }}
      onResourceResolve={async () => binding} onResourceRequest={async () => {}}
    />);
    expect(container.querySelector('.orchard-bubble img')?.getAttribute('alt')).toBe('Summary diagram');
    expect(container.querySelector('img')?.getAttribute('width')).toBe('640');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('[data-resource-download]')).toBeNull();
  });

  it.each(['user_message', 'assistant_message'] as const)('keeps image and file attachments on %s while the work line hides tool resources', async type => {
    const image = { locator: 'codex-image:opaque', resourceId: 'picture', status: 'available' as const };
    const file = { locator: '/workspace/report.md', resourceId: 'report', status: 'available' as const };
    const content: AgentTimelineItem = type === 'user_message'
      ? { type, text: 'Review this picture and report.', content: [{ type: 'image', locator: image.locator, label: 'image #11' }, { type: 'text', text: 'Review this picture and report.' }] }
      : { type, text: 'The picture and report are ready.' };
    // The person's message opens the turn and the tool is its work; an assistant's message after the tool is the answer.
    const ordered = type === 'user_message' ? [content, items[3]!] : [items[3]!, content];
    const current = state(ordered);
    const container = await render(<AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map(entry => ({ ...entry,
        resources: entry.item === content ? [image, file] : [{ locator: '/workspace/internal.log', resourceId: 'log', status: 'available' }],
      })) }, resources: {
        picture: { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'picture', contentBase64: 'AA==' },
        report: { status: 'available', mediaType: 'text/markdown', byteLength: 1, sha256: 'report', contentBase64: 'AA==' },
      } }}
    />);
    expect(container.querySelectorAll('.agent-resources li')).toHaveLength(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe(type === 'user_message' ? 'image #11' : 'Image');
    expect(container.querySelector('[data-resource-download="report"]')?.getAttribute('download')).toBe('report.md');
    expect(container.textContent).toContain('report.md');
    expect(container.textContent).not.toContain(image.locator);
    expect(container.textContent).not.toContain('internal.log');
  });

  it('keeps attachment status and retry controls available on a bubble', async () => {
    const binding = { locator: 'attachment:opaque', resourceId: 'attachment', status: 'pending' as const };
    const base = state([{ type: 'user_message', text: 'Review the attached file.' }]);
    const current = { ...base, timeline: { ...base.timeline, entries: base.timeline.entries.map(entry => ({ ...entry, resources: [binding] })) } };
    const request = vi.fn(async () => { throw new Error('Connection unavailable'); });
    const view = (resources: Parameters<typeof AgentTimeline>[0]['state']['resources']) =>
      <AgentTimeline state={{ ...current, resources }} onResourceRequest={request} />;
    const container = await render(view({ attachment: { status: 'pending', retryAfterMs: 100 } }));
    expect(container.querySelector('.agent-resources')?.textContent).toContain('Pending');
    await rerender(container, view({ attachment: { status: 'failed', message: 'File could not be read.', retryable: true } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('File could not be read.');
    await rerender(container, view({ attachment: { status: 'unavailable', reason: 'File no longer exists.' } }));
    expect(container.querySelector('.agent-resources')?.textContent).toContain('File no longer exists.');
    await rerender(container, view({ attachment: { status: 'available', mediaType: 'text/plain', byteLength: 10, sha256: 'file' } }));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-resource-id="attachment"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connection unavailable');
    expect(container.querySelector<HTMLButtonElement>('[data-resource-id="attachment"]')?.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-resource-id="attachment"]')!.click());
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('deduplicates rendered Markdown images without hiding other attachments or image syntax in code', async () => {
    const current = state([{ type: 'assistant_message', text: '![Diagram][result]\n\n[result]: ./diagram.png\n\n`![Example](./example.png)`\n\n```md\n![Example](./fenced.png)\n```' }]);
    const bindings = ['diagram', 'example', 'fenced', 'attached'].map(name => ({ locator: `./${name}.png`, resourceId: name, status: 'available' as const }));
    const container = await render(<AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map(entry => ({ ...entry, resources: bindings })) },
        resources: Object.fromEntries(bindings.map(binding => [binding.resourceId, { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: binding.resourceId, contentBase64: 'AA==' }])) }}
      onResourceResolve={async locator => bindings.find(binding => binding.locator === locator)!} onResourceRequest={async () => {}}
    />);
    expect(container.querySelectorAll('img')).toHaveLength(4);
    expect(container.querySelectorAll('.agent-resources li')).toHaveLength(3);
    expect(container.querySelector('[data-resource-download="diagram"]')).toBeNull();
    for (const id of ['example', 'fenced', 'attached']) expect(container.querySelector(`[data-resource-download="${id}"]`)).not.toBeNull();
  });

  it('keeps messages and decisions in Concise, says a failed step on the work line, and shows every step in Full', async () => {
    const content = state();
    const view = (mode: ProcessMode, current = content) => <AgentTimeline state={current} processMode={mode} onInspectEntry={() => {}} />;
    const container = await render(view('full'));
    const summary = container.querySelector('[data-entry-key="test:9:summary"]');
    expect(container.querySelector('.agent-tool')).not.toBeNull();
    await rerender(container, view('concise'));
    // The prompt, the answered plan review and the answer; the remark between steps folds into the work line.
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(3);
    expect(container.querySelector('.agent-message-user strong')?.textContent).toBe('fix');
    expect(container.querySelector('h2')?.textContent).toBe('Agent timeline');
    expect(container.querySelector('.agent-message-assistant h2')?.textContent).toBe('Summary');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('[data-entry-key="test:9:summary"]')).toBe(summary);
    expect(container.querySelector('.agent-work-line')?.textContent).toContain('1 step failed');
    for (const hidden of ['Internal reasoning', 'Tool output', 'Checking the report.', 'Runtime notice']) {
      expect(container.textContent).not.toContain(hidden);
    }
    await rerender(container, view('concise', state([...items.slice(0, -1), { ...items.at(-1)!, type: 'assistant_message', text: 'Streaming summary updated.' }])));
    expect(summary?.textContent).toContain('Streaming summary updated.');
    await rerender(container, view('full'));
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(items.length);
    expect(container.querySelector('.agent-tool')).not.toBeNull();
    expect(container.querySelector('.agent-content-preview')).not.toBeNull();
  });

  it('shows earlier content above its own entries once its oldest page is loaded, in place of the empty text', async () => {
    const earlier = <section data-testid="earlier">Earlier conversation</section>;
    const loaded = state();
    let container = await render(<AgentTimeline state={loaded} timelineStart={earlier} />);
    const slot = container.querySelector('[data-testid="earlier"]')!;
    expect(slot).not.toBeNull();
    expect(slot.compareDocumentPosition(container.querySelector('[data-entry-key]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // While older pages of its own remain, they come first: the earlier content waits behind History controls.
    container = await render(<AgentTimeline state={{ ...loaded, timeline: { ...loaded.timeline, hasOlder: true } }} onLoadOlder={async () => {}} timelineStart={earlier} />);
    expect(container.querySelector('[data-testid="earlier"]')).toBeNull();
    // An empty successor shows the earlier content, not the empty text.
    const empty = state([]);
    container = await render(<AgentTimeline state={empty} timelineStart={earlier} />);
    expect(container.querySelector('[data-testid="earlier"]')).not.toBeNull();
    expect(container.querySelector('.agent-timeline-empty')).toBeNull();
  });

  it('shows presence below the latest entry, without changing the entries or replacing the empty text', async () => {
    const typing = <div data-testid="typing" role="status">Working</div>;
    const loaded = state();
    let container = await render(<AgentTimeline state={loaded} timelineEnd={typing} />);
    const slot = container.querySelector('[data-testid="typing"]')!;
    const entries = [...container.querySelectorAll('[data-entry-key]')];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.at(-1)!.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.closest('.agent-timeline-entries')).not.toBeNull();
    container = await render(<AgentTimeline state={state([])} timelineEnd={typing} />);
    expect(container.querySelector('[data-testid="typing"]')).not.toBeNull();
  });

  it('shows a page of only work as its work line, and keeps older history reachable', async () => {
    const current = state(items.filter(item => ['tool_call', 'reasoning', 'compaction'].includes(item.type)));
    const container = await render(<AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, hasOlder: true } }} onLoadOlder={async () => {}}
    />);
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(0);
    expect(container.querySelector('.agent-timeline-empty')).toBeNull();
    expect(container.querySelector('.agent-work-line button')?.textContent).toBe('Thought it through, ran a command, tidied up the context');
    expect(container.querySelector<HTMLButtonElement>('.agent-load-older')?.disabled).toBe(false);
  });

  it('keeps pending questions actionable outside the filtered history', async () => {
    const container = await render(<AgentTimeline state={{ ...state(), pendingInteractions: [{
      kind: 'plan_approval', requestId: 'pending-plan', plan: 'Please review this plan.', allowedActions: ['approve'],
    }] }} onInteractionResponse={async () => {}} />);
    // The request is a card at the end of the last turn, with Allow at hand and the plan under Show what changes.
    const card = container.querySelector('.agent-turn:last-of-type .agent-plan')!;
    expect(card.querySelector<HTMLButtonElement>('[data-choice="allow"]')?.disabled).toBe(false);
    await showChanges(container);
    expect(card.textContent).toContain('Please review this plan.');
    expect(container.querySelector<HTMLButtonElement>('[data-action="approve"]')?.disabled).toBe(false);
  });
});
