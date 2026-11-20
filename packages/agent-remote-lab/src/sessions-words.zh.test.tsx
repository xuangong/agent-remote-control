import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { translator } from '@orchardworks/agent-client';
import type { OutboxEntry } from '@orchardworks/agent-remote-protocol';
import { render } from './test/setup.js';
import { AsleepNotice } from './components/AsleepNotice.js';
import { ChatSessionManager } from './components/ChatSessionManager.js';
import { CollapsedConversations } from './components/CollapsedConversations.js';
import { NativeDaemonRecovery } from './components/NativeSessionCommands.js';
import { OutboxMessages, waitingAge } from './components/OutboxMessages.js';
import { ProviderSessionControls } from './components/ProviderSessionControls.js';
import { QuoteMessagesButton, QuoteSelectionBar } from './components/SessionQuotes.js';
import { MissingSessionNote, SessionConnectionNotice, sessionConnectionFailure } from './components/SessionConnectionNotice.js';
import { ReauthenticationNotice } from './components/ReauthenticationNotice.js';
import { SessionTitle } from './components/SessionTitle.js';
import { ToastProvider, useFeedbackToast } from './components/Toast.js';
import { WorkspaceFolderPicker } from './components/WorkspaceFolderPicker.js';
import type { SessionEntry } from './session-tree.js';

const zh = (node: React.ReactNode) => render(<LocaleContext.Provider value="zh">{node}</LocaleContext.Provider>);

describe('the session screens in Chinese', () => {
  it('says the sign-in and wake notices in the reader\'s words', async () => {
    const reauth = await zh(<ReauthenticationNotice purpose="permissions" />);
    expect(reauth.textContent).toContain('登录后才能改权限');
    expect(reauth.querySelector('a')?.textContent).toBe('重新登录');
    const asleep = await zh(<AsleepNotice onWake={() => undefined} />);
    expect(asleep.textContent).toContain('在睡觉');
  });

  it('shows a message that waits in the outbox, and how long it waited, in Chinese', async () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const entry: OutboxEntry = { id: '00000000-0000-4000-8000-000000000001', hostId: 'mac', providerId: 'codex', nativeSessionId: 'thread', text: 'Message 1', createdAt: now - 5 * 60_000, status: 'waiting' };
    const container = await zh(<OutboxMessages entries={[entry]} hostName="Mac mini" hostOnline={false} now={now} onCancel={async () => {}} onRetry={async () => {}} />);
    expect(container.querySelector('.agent-message-delivery')?.textContent).toContain('等 Mac mini 上线 · 5 分钟');
    expect(waitingAge(now - 2 * 3_600_000, now, translator('zh'))).toBe('2 小时');
  });

  it('labels the provider controls and the connection notice in Chinese', async () => {
    const controls = await zh(<ProviderSessionControls providers={[]} selectedProviderId="" catalogStatus="empty" creating={false} onRetryProviders={() => undefined} onSelectedProviderChange={() => undefined} onCreateSession={() => undefined} />);
    expect(controls.textContent).toContain('还没有注册服务商');
    const notice = sessionConnectionFailure(Object.assign(new Error('late'), { name: 'DirectoryError', code: 'host_offline' }), false, translator('zh'));
    const shown = await zh(<SessionConnectionNotice notice={{ ...notice, code: 'host_offline' }} />);
    expect(shown.querySelector('summary')?.textContent).toBe('连接详情');
    const missing = await zh(<MissingSessionNote title="Plan" host="Mac mini" />);
    expect(missing.textContent).toContain('在 Mac mini 上已经不存在了');
  });

  it('names the quote controls and the restart advice in Chinese', async () => {
    const button = await zh(<QuoteMessagesButton onClick={() => undefined} />);
    expect(button.querySelector('button')?.getAttribute('aria-label')).toBe('引用消息');
    const bar = await zh(<QuoteSelectionBar count={2} windows={[]} busy={false} onQuote={() => undefined} onCancel={() => undefined} />);
    expect(bar.querySelector('[role="status"]')?.textContent).toContain('2 条消息已选中');
    const recovery = await zh(<NativeDaemonRecovery />);
    expect(recovery.querySelector('summary')?.textContent).toBe('重启守护进程来恢复…');
  });

  it('shows the folder picker, the session menu and collapsed windows in Chinese', async () => {
    const directory = { workspaces: async () => ({ workspaces: [] }), folders: async () => ({ path: '/work', parentPath: null, roots: [], folders: [], nextOffset: null }) };
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
    const picker = await zh(<WorkspaceFolderPicker directory={directory as never} providerId="codex" workspaces={[]} onSelect={() => undefined} onClose={() => undefined} />);
    expect(document.body.textContent).toContain('选一个工作区文件夹');
    picker.remove();
    const parent: SessionEntry = { providerId: 'codex', nativeSessionId: 'parent', title: 'Parent', status: 'running' };
    const child: SessionEntry = { ...parent, nativeSessionId: 'child', parentNativeSessionId: 'parent', title: '/root/review' };
    const manager = await zh(<ChatSessionManager current={parent} entries={[parent, child]} busy={false} onOpen={() => undefined} />);
    expect(manager.querySelector('.lab-chat-sessions-heading')?.textContent).toContain('1 个在忙');
    const collapsed = await zh(<CollapsedConversations sessions={[{ agentId: 'a', providerId: 'codex', nativeSessionId: 's', title: 'Plan' }]} offset={0} onExpand={() => undefined} />);
    expect(collapsed.querySelector('nav')?.getAttribute('aria-label')).toBe('前面的窗口');
    const title = await zh(<SessionTitle title="Plan" onRename={() => undefined} />);
    expect(title.querySelector('strong')?.getAttribute('title')).toBe('Plan — 双击可以重命名会话');
  });

  it('counts a toast down in Chinese', async () => {
    vi.useFakeTimers();
    function Feedback() { useFeedbackToast('会话连接', 'Host 没有回应', 'error'); return null; }
    const container = await zh(<ToastProvider><Feedback /></ToastProvider>);
    expect(container.querySelector('.lab-toast')?.textContent).toContain('10 秒后关闭');
    expect(container.querySelector('.lab-toast button')?.getAttribute('aria-label')).toBe('关闭通知：会话连接');
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    vi.useRealTimers();
  });
});
