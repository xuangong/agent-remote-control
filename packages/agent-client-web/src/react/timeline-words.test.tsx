// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInteractionRequest, AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

import { AgentChildSessionList } from './AgentChildSessionList.js';
import { InteractionPanel } from './InteractionPanel.js';
import { LocaleContext } from './locale.js';
import { FileChangesView } from './items/FileChangesView.js';
import { ToolCallItem } from './items/ToolCallItem.js';
import { TodoItem } from './items/TodoItem.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.innerHTML = ''; });

async function chinese(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<LocaleContext.Provider value="zh">{node}</LocaleContext.Provider>));
  return host;
}

describe('the conversation detail in Chinese', () => {
  it('reads the steps of a tool call and its result', async () => {
    const item: Extract<AgentTimelineItem, { type: 'tool_call' }> = {
      type: 'tool_call', id: 'call', name: 'Bash', status: 'completed', error: null,
      detail: { type: 'shell', command: 'ls' }, result: { content: [{ type: 'text', text: '' }], exitCode: 0 },
    } as never;
    const host = await chinese(<ToolCallItem item={item} />);
    expect(host.querySelector('.agent-state-label')?.textContent).toBe('完成了');
    expect(host.textContent).toContain('看看完整结果');
  });

  it('reads file changes and the plan', async () => {
    const files = await chinese(<FileChangesView files={[{ path: 'a.ts', kind: 'added', diff: '@@ -0,0 +1 @@\n+x' }]} />);
    expect(files.querySelector('section')?.getAttribute('aria-label')).toBe('文件改动');
    expect(files.textContent).toContain('新增');
    const todo = await chinese(<TodoItem item={{ type: 'todo', items: [{ text: 'Write it', status: 'in_progress' }] } as never} />);
    expect(todo.textContent).toContain('执行计划');
    expect(todo.textContent).toContain('进行中');
  });

  it('reads an approval and the subagents', async () => {
    const request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }> = {
      kind: 'tool_approval', requestId: 'r', toolCallId: 'c', toolName: 'command', summary: 'Why',
      detail: { type: 'shell', command: 'ls' }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once', 'session'],
    };
    const approval = await chinese(<InteractionPanel request={request} onResponse={async () => {}} assistantName="Chief" />);
    expect(approval.textContent).toContain('好的');
    expect(approval.textContent).toContain('这段会话都可以');
    const children = await chinese(<AgentChildSessionList children={[{ nativeSessionId: 'a', title: 'a', status: 'running', observation: 'live' }]} />);
    expect(children.textContent).toContain('1 个在忙');
    expect(children.textContent).toContain('在忙');
  });
});
