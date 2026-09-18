import { describe, expect, it } from 'vitest';
import type { AgentTimelineItem } from '@agent-remote-controller/agent-remote-protocol';
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

  it('keeps inline Markdown images while hiding attached resource cards and renderer extensions', async () => {
    const binding = { locator: './summary.png', resourceId: 'summary-image', status: 'available' as const };
    const current = state([{ type: 'assistant_message', text: '![Summary diagram](./summary.png)' }]);
    const registry = new RendererRegistry();
    registry.register('assistant_message', () => <p>Execution extension</p>);
    const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline
      state={{ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map(entry => ({ ...entry, resources: [binding] })) },
        resources: { 'summary-image': { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'image', contentBase64: 'AA==', imageDimensions: { width: 640, height: 480 } } } }}
      registry={registry} onResourceResolve={async () => binding} onResourceRequest={async () => {}}
    /></TimelineDisplay.Provider>);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Summary diagram');
    expect(container.querySelector('img')?.getAttribute('width')).toBe('640');
    expect(container.querySelector('[data-resource-download]')).toBeNull();
    expect(container.textContent).not.toContain('Execution extension');
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
    expect(container.querySelectorAll('[data-entry-key]')).toHaveLength(5);
    expect(container.querySelector('.agent-message-user strong')?.textContent).toBe('fix');
    expect(container.querySelector('h2')?.textContent).toBe('Agent timeline');
    expect(container.querySelector('.agent-message-assistant h2')?.textContent).toBe('Summary');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('.agent-inspect-entry')).toBeNull();
    expect(container.querySelector('[data-entry-key="epoch:test:9:summary"]')).toBe(summary);
    expect([...container.querySelectorAll('.agent-message-assistant')].map(node => node.getAttribute('data-message-group'))).toEqual(['single', 'single']);
    for (const hidden of ['Internal reasoning', 'Tool output', 'Runtime notice']) {
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
    const current = state(items.filter(item => ['tool_call', 'reasoning', 'error', 'compaction'].includes(item.type)));
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
