import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TimelineDisplay, type TimelineDisplayMode } from './TimelineDisplay.js';
import { RendererRegistry } from './renderer-registry.js';

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

describe('content-only timeline', () => {
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
    const view = (entries: AgentTimelineItem[]) => <TimelineDisplay.Provider value="content"><AgentTimeline state={state(entries)} /></TimelineDisplay.Provider>;
    const container = await render(view(content));
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(5);
    expect(container.querySelector('.agent-todo')?.textContent).toContain('In progress');
    expect(container.querySelector('.agent-tool')?.textContent).toContain('Running');
    expect(container.querySelector('.agent-question-completed')?.textContent).toContain('Mobile');
    expect(container.querySelector('.agent-question-completed')?.textContent).toContain('Which platform?');
    expect(container.querySelector('.agent-plan-completed')?.textContent).toContain('Include desktop too.');
    expect(container.querySelector('.agent-tool-approval-completed')?.textContent).toContain('Denied');
    await act(async () => container.querySelector<HTMLButtonElement>('.agent-approval-receipt-toggle')!.click());
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

  it.each(['./summary.png', 'codex-image:generated', 'claude-image:tool', 'opencode-image:output', 'dsh-attachment:picture', 'another-agent:picture'])('renders bound Markdown image %s without resource cards or renderer extensions', async locator => {
    const binding = { locator, resourceId: 'summary-image', status: 'available' as const };
    const current = state([{ type: 'assistant_message', text: `![Summary diagram](${locator})` }]);
    const registry = new RendererRegistry();
    registry.register('assistant_message', () => <p>Execution extension</p>);
    const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map(entry => ({ ...entry, resources: [binding] })) },
        resources: { 'summary-image': { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'image', contentBase64: 'AA==', imageDimensions: { width: 640, height: 480 } } } }}
      registry={registry} onResourceResolve={async () => binding} onResourceRequest={async () => {}}
    /></TimelineDisplay.Provider>);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Summary diagram');
    expect(container.querySelector('img')?.getAttribute('width')).toBe('640');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('[data-resource-download]')).toBeNull();
    expect(container.textContent).not.toContain('Execution extension');
  });

  it.each(['user_message', 'assistant_message'] as const)('keeps image and file attachments on %s while hiding tool resources', async type => {
    const image = { locator: 'codex-image:opaque', resourceId: 'picture', status: 'available' as const };
    const file = { locator: '/workspace/report.md', resourceId: 'report', status: 'available' as const };
    const content: AgentTimelineItem = type === 'user_message'
      ? { type, text: 'Review this picture and report.', content: [{ type: 'image', locator: image.locator, label: 'image #11' }, { type: 'text', text: 'Review this picture and report.' }] }
      : { type, text: 'The picture and report are ready.' };
    const current = state([content, items[3]!]);
    const registry = new RendererRegistry();
    registry.register(type, () => <p>Execution extension</p>);
    const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map((entry, index) => ({ ...entry,
        resources: index === 0 ? [image, file] : [{ locator: '/workspace/internal.log', resourceId: 'log', status: 'available' }],
      })) }, resources: {
        picture: { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'picture', contentBase64: 'AA==' },
        report: { status: 'available', mediaType: 'text/markdown', byteLength: 1, sha256: 'report', contentBase64: 'AA==' },
      } }} registry={registry}
    /></TimelineDisplay.Provider>);
    expect(container.querySelectorAll('.agent-resources li')).toHaveLength(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe(type === 'user_message' ? 'image #11' : 'Image');
    expect(container.querySelector('[data-resource-download="report"]')?.getAttribute('download')).toBe('report.md');
    expect(container.textContent).toContain('report.md');
    expect(container.textContent).not.toContain(image.locator);
    expect(container.textContent).not.toContain('internal.log');
    expect(container.textContent).not.toContain('Execution extension');
  });

  it('keeps attachment status and retry controls available in content-only mode', async () => {
    const binding = { locator: 'attachment:opaque', resourceId: 'attachment', status: 'pending' as const };
    const base = state([{ type: 'user_message', text: 'Review the attached file.' }]);
    const current = { ...base, timeline: { ...base.timeline, entries: base.timeline.entries.map(entry => ({ ...entry, resources: [binding] })) } };
    const request = vi.fn(async () => { throw new Error('Connection unavailable'); });
    const view = (resources: Parameters<typeof AgentTimeline>[0]['state']['resources']) => <TimelineDisplay.Provider value="content">
      <AgentTimeline state={{ ...current, resources }} onResourceRequest={request} />
    </TimelineDisplay.Provider>;
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
    const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map(entry => ({ ...entry, resources: bindings })) },
        resources: Object.fromEntries(bindings.map(binding => [binding.resourceId, { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: binding.resourceId, contentBase64: 'AA==' }])) }}
      onResourceResolve={async locator => bindings.find(binding => binding.locator === locator)!} onResourceRequest={async () => {}}
    /></TimelineDisplay.Provider>);
    expect(container.querySelectorAll('img')).toHaveLength(4);
    expect(container.querySelectorAll('.agent-resources li')).toHaveLength(3);
    expect(container.querySelector('[data-resource-download="diagram"]')).toBeNull();
    for (const id of ['example', 'fenced', 'attached']) expect(container.querySelector(`[data-resource-download="${id}"]`)).not.toBeNull();
  });

  it('keeps messages, task progress and approval history while hiding execution details', async () => {
    const content = state();
    const view = (mode: TimelineDisplayMode, current = content) => <TimelineDisplay.Provider value={mode}>
      <AgentTimeline state={current} onInspectEntry={() => {}} />
    </TimelineDisplay.Provider>;
    const container = await render(view('preview'));
    const summary = container.querySelector('[data-entry-key="epoch:test:9:summary"]');
    expect(container.querySelector('.agent-tool')).not.toBeNull();
    await rerender(container, view('content'));
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(6);
    expect(container.querySelector('.agent-message-user strong')?.textContent).toBe('fix');
    expect(container.querySelector('h2')?.textContent).toBe('Agent timeline');
    expect(container.querySelector('.agent-message-assistant h2')?.textContent).toBe('Summary');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('.agent-inspect-entry')).toBeNull();
    expect(container.querySelector('[data-entry-key="epoch:test:9:summary"]')).toBe(summary);
    expect([...container.querySelectorAll('.agent-message-assistant')].map(node => node.getAttribute('data-message-group'))).toEqual(['single', 'single']);
    expect(container.textContent).toContain('Runtime notice');
    for (const hidden of ['Internal reasoning', 'Tool output']) {
      expect(container.textContent).not.toContain(hidden);
    }
    await rerender(container, view('content', state([...items.slice(0, -1), { ...items.at(-1)!, type: 'assistant_message', text: 'Streaming summary updated.' }])));
    expect(summary?.textContent).toContain('Streaming summary updated.');
    await rerender(container, view('simple'));
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(items.length);
    expect(container.querySelector('.agent-tool')).not.toBeNull();
    expect(container.querySelector('.agent-content-preview')).toBeNull();
  });

  it('shows an empty message view when a loaded page contains only execution events and keeps older history reachable', async () => {
    const current = state(items.filter(item => ['tool_call', 'reasoning', 'compaction'].includes(item.type)));
    const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, hasOlder: true } }} onLoadOlder={async () => {}}
    /></TimelineDisplay.Provider>);
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(0);
    expect(container.querySelector('.agent-timeline-empty')?.textContent).toBe('No conversation content in the loaded history.');
    expect(container.querySelector<HTMLButtonElement>('.agent-load-older')?.disabled).toBe(false);
  });

  it('keeps pending questions actionable outside the filtered history', async () => {
    const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline state={{ ...state(), pendingInteractions: [{
      kind: 'plan_approval', requestId: 'pending-plan', plan: 'Please review this plan.', allowedActions: ['approve'],
    }] }} onInteractionResponse={async () => {}} /></TimelineDisplay.Provider>);
    expect(container.querySelector('.agent-interactions')?.textContent).toContain('Please review this plan.');
    expect(container.querySelector<HTMLButtonElement>('[data-action="approve"]')?.disabled).toBe(false);
  });
});
