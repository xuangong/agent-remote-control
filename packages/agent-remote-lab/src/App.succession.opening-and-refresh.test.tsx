import { notifyFeedReopened } from '@orchardworks/agent-client';
import 'fake-indexeddb/auto';
import { type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { HttpWebSocketTransport } from '@orchardworks/agent-client';
import { type SuccessionActionResult } from './directory-client.js';
import { DraftStore } from './draft-store.js';
import { SessionLocatorSynchronizingError } from './session-view-operations.js';
import * as successionHooks from './hooks/useSessionSuccession.js';
import * as workbenchComponents from './components/LabWorkbench.js';
import * as historyHooks from './hooks/useConversationHistory.js';
import * as directoryComponents from './components/SessionDirectory.js';
import { saveStoredDisplay } from './stored-display.js';
import { act, cachedConversation, cleanups, committed, editVisiblePrompt, failureFixture, handoffCommandFixture, native, openSessions, settleApp, successionHistoryLink, testDeadline, visibleQuery, visibleText, waitFor, windowHandoffFixture } from './App.succession.fixture.js';

it.each(['recovering', 'attach-failed', 'identity-mismatch'] as const)('keeps sharing the selected session while %s', async phase => {
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  cleanups.push(() => { if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); });
  const f = await failureFixture(false, 'wrong-native', false, '', {
    chain: [], selected: 'B', providerId: 'codex', holdReplayInitially: phase === 'recovering',
    attachmentFailure: phase === 'attach-failed' ? () => ({ status: 403, payload: { error: 'Session cannot be opened.' } }) : undefined,
  });
  if (phase !== 'recovering') await settleApp(() => expect(f.view.textContent).toContain(
    phase === 'attach-failed' ? 'Session cannot be opened.' : 'The native session identity could not be confirmed.',
  ));
  const share = f.view.querySelector<HTMLButtonElement>('[aria-label="Share session link"]');
  expect(share).not.toBeNull();
  expect(share!.disabled).toBe(false);
  await act(async () => share!.click());
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="Share session"]')!;
  expect(dialog).not.toBeNull();
  const url = new URL(dialog.querySelector<HTMLInputElement>('#session-transfer-url')!.value);
  expect(url.searchParams.get('host')).toBe('host');
  expect(url.searchParams.get('provider')).toBe('codex');
  expect(url.searchParams.get('session')).toBe('B');
  expect(url.searchParams.has('agent')).toBe(false);
  // B is not a native Codex ID, so there is no command to offer.
  expect(dialog.textContent).not.toContain('Open on Host');
});

it('retains a local resume command for a session that cannot be opened', async () => {
  const id = '01a0be55-d755-7d72-8463-5a04a193e20e';
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} });
  cleanups.push(() => { if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); });
  const f = await failureFixture(false, undefined, false, '', {
    chain: [], selected: id, providerId: 'codex',
    attachmentFailure: () => ({ status: 403, payload: { error: 'Session cannot be opened.' } }),
  });
  await settleApp(() => expect(f.view.textContent).toContain('Session cannot be opened.'));
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Share session link"]')!.click());
  const command = document.querySelector<HTMLInputElement>('.lab-native-session-command input');
  expect(command?.value).toBe(`agent-remote-controller session attach host/codex/${id}`);
});

it.each(['A', 'B'])('keeps native takeover visible from failed initial binding %s until explicit takeover is confirmed', async nativeSessionId => {
  const generation = 'native-owner-generation';
  const f = await failureFixture(false, nativeSessionId, false, '', { chain: nativeSessionId === 'A' ? [] : [committed()], attachmentFailure(body) {
    if (!body.takeOver) return { status: 409, payload: { code: 'native_session_owned',
      error: 'This session is controlled by another native client.', nativeOwner: { kind: 'native_cli', generation } } };
  } });
  const takeover = () => f.view.querySelector<HTMLButtonElement>('[aria-label="Interrupt and take control"]');
  await settleApp(() => expect(takeover()).not.toBeNull());
  expect(takeover()!.closest('[hidden]')).toBeNull();
  expect(f.view.textContent).toContain('Taking over interrupts its running work.');
  expect(f.view.textContent).not.toContain('This session is controlled by another native client.');
  expect(f.view.querySelector('[data-testid="prompt-submit"]')).toBeNull();
  expect(f.requests.filter(request => request.url.endsWith('/attach')).map(request => request.body?.takeOver)).toEqual([undefined]);
  const release = f.holdAttach(nativeSessionId), releaseControl = f.holdControl();
  try {
    await act(async () => takeover()!.click());
    await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(2));
    expect(f.view.querySelector('.lab-session-control')?.getAttribute('aria-busy')).toBe('true');
    expect(f.view.querySelector<HTMLButtonElement>('[aria-label="Taking control…"]')?.disabled).toBe(true);
    expect(f.requests.filter(request => request.url.endsWith('/attach'))[1]!.body).toMatchObject({ nativeSessionId, takeOver: generation });
    expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
    const controlRequests = f.frames.filter(frame => frame.message?.type === 'session_control_request').length;
    await act(async () => release());
    await settleApp(() => expect(f.frames.filter(frame => frame.message?.type === 'session_control_request').length).toBeGreaterThan(controlRequests));
    // Every phase of the take-over says the same words (I1).
    expect(f.view.querySelector<HTMLButtonElement>('[aria-label="Taking control…"]')?.disabled).toBe(true);
    expect(f.view.querySelector('[data-testid="prompt-submit"]')).toBeNull();
    await act(async () => releaseControl());
    await settleApp(() => {
      expect(f.view.querySelector('.lab-session-control')).toBeNull();
      expect(f.view.querySelector('[data-testid="prompt-submit"]')).not.toBeNull();
    });
  } finally { release(); releaseControl(); }
});

it('retains an uncertain initial takeover and checks status without repeating the interruption', async () => {
  const generation = 'uncertain-native-owner';
  let interrupted = false;
  const f = await failureFixture(false, 'A', false, '', { chain: [], attachmentFailure(body) {
    if (body.takeOver) {
      interrupted = true;
      return { status: 409, payload: { code: 'native_handoff_unknown', error: 'Native release could not be confirmed.' } };
    }
    if (!interrupted) return { status: 409, payload: { code: 'native_session_owned', error: 'Native CLI has control.', nativeOwner: { kind: 'native_cli', generation } } };
  } });
  await settleApp(() => expect(f.view.querySelector('[aria-label="Interrupt and take control"]')).not.toBeNull());
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Interrupt and take control"]')!.click());
  await settleApp(() => expect(f.view.querySelector('[aria-label="Check session status"]')).not.toBeNull());
  expect(f.view.textContent).toContain('Native release could not be confirmed.');
  expect(f.view.querySelector('.lab-session-control-error')?.textContent).toContain('Handoff is not confirmed.');
  expect(f.view.querySelector('[data-testid="prompt-submit"]')).toBeNull();
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Check session status"]')!.click());
  await settleApp(() => {
    expect(f.view.querySelector('.lab-session-control')).toBeNull();
    expect(f.view.querySelector('[data-testid="prompt-submit"]')).not.toBeNull();
  });
  expect(f.requests.filter(request => request.url.endsWith('/attach')).map(request => request.body?.takeOver)).toEqual([undefined, generation, undefined]);
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
});

it('shows exact cached content while replay and native attachment wait without granting control', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { holdReplayInitially: true, seed(scope) {
    for (const nativeSessionId of ['A', 'B']) saveStoredDisplay(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId }, cachedConversation(nativeSessionId));
  } });
  const releaseReplay = f.pauseReplay(), releaseAttach = f.holdAttach('B');
  try {
    await settleApp(() => expect(visibleText(f.view)).toContain('Cached A content'));
    expect(succession.binding).toBeUndefined(); expect(succession.isCurrent()).toBe(false);
    expect(succession.sessionState.connection).toBe('connecting');
    expect(succession.sessionState.operations.send_message.allowed).toBe(false);
    expect(f.requests.some(request => request.url.endsWith('/attach'))).toBe(false);
    await act(async () => releaseReplay());
    await settleApp(() => { expect(succession.selected?.nativeSessionId).toBe('B'); expect(visibleText(f.view)).toContain('Cached B content'); });
    expect(visibleText(f.view)).not.toContain('Cached A content');
    expect(succession.binding).toBeUndefined();
    expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
    await act(async () => releaseAttach());
    await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(succession.sessionState.connection).toBe('ready'); });
    expect(f.requests.filter(request => request.url.endsWith('/attach')).every(request => request.body?.nativeSessionId === 'B')).toBe(true);
  } finally { releaseReplay(); releaseAttach(); }
});

it('retains edits made beside cached content before initial checks and native attachment finish', async () => {
  const real = successionHooks.useSessionSuccession, realWorkbench = workbenchComponents.LabWorkbench;
  let succession!: ReturnType<typeof real>, primary!: ComponentProps<typeof realWorkbench>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return realWorkbench(props); });
  const f = await failureFixture(false, 'B', false, '', { holdReplayInitially: true, seed(scope) {
    saveStoredDisplay(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A' }, cachedConversation('A'));
  } });
  const releaseReplay = f.pauseReplay(), releaseAttach = f.holdAttach('B');
  try {
    await settleApp(() => expect(visibleText(f.view)).toContain('Cached A content'));
    const owner = primary.draftBinding;
    expect(owner).toBeDefined();
    expect(succession.binding).toBeUndefined();
    await editVisiblePrompt(f.view, 'Edited before checks completed');
    expect(owner!.store.get(owner!.key)).toBe('Edited before checks completed');
    await settleApp(() => expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('Edited before checks completed'));
    await act(async () => releaseReplay());
    await settleApp(() => expect(succession.selected?.nativeSessionId).toBe('B'));
    expect(primary.draftBinding).toEqual(owner);
    await settleApp(() => expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('Edited before checks completed'));
    await act(async () => releaseAttach());
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
    expect(primary.draftBinding).toEqual(owner);
    await settleApp(() => expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('Edited before checks completed'));
    expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toEqual([]);
  } finally { releaseReplay(); releaseAttach(); }
});

it('retains the selected session draft while cached navigation waits for checks and binding', async () => {
  const real = successionHooks.useSessionSuccession, realWorkbench = workbenchComponents.LabWorkbench;
  const realDirectory = directoryComponents.SessionDirectory;
  let directory!: ComponentProps<typeof realDirectory>;
  vi.spyOn(directoryComponents, 'SessionDirectory').mockImplementation(props => { directory = props; return realDirectory(props); });
  let succession!: ReturnType<typeof real>, primary!: ComponentProps<typeof realWorkbench>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return realWorkbench(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [], seed(scope) {
    saveStoredDisplay(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId: 'C' }, cachedConversation('C'));
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const releaseReplay = f.pauseReplay(), releaseAttach = f.holdAttach('C');
  try {
    await act(async () => { directory.onSelect({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'C', agentId: 'agent-C', title: 'C' }); });
    // C opens beside A (rule 6) as the selected primary group, showing its cached content at once.
    const groupC = () => f.view.querySelector<HTMLElement>('[data-primary-group-id][data-selected="true"]')!;
    await settleApp(() => expect(visibleText(groupC())).toContain('Cached C content'));
    const owner = primary.draftBinding;
    expect(owner).toBeDefined();
    await editVisiblePrompt(groupC(), 'C edit before connection');
    expect(owner!.store.get(owner!.key)).toBe('C edit before connection');
    expect(visibleQuery(groupC(), '[data-testid="prompt-input"]')?.textContent).toBe('C edit before connection');
    await act(async () => releaseReplay());
    await settleApp(() => expect(succession.desired?.target.native.nativeSessionId).toBe('C'));
    expect(primary.draftBinding).toEqual(owner);
    await act(async () => releaseAttach());
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
    expect(primary.draftBinding).toEqual(owner);
    expect(visibleQuery(groupC(), '[data-testid="prompt-input"]')?.textContent).toBe('C edit before connection');
    expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toEqual([]);
  } finally { releaseReplay(); releaseAttach(); }
});

it('opens a selected session beside with its cached content at once, and an uncached one without content', async () => {
  const real = successionHooks.useSessionSuccession;
  const realDirectory = directoryComponents.SessionDirectory;
  let directory!: ComponentProps<typeof realDirectory>;
  vi.spyOn(directoryComponents, 'SessionDirectory').mockImplementation(props => { directory = props; return realDirectory(props); });
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [], timeline: cachedConversation('A').timeline.entries, seed(scope) {
    saveStoredDisplay(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId: 'C' }, cachedConversation('C'));
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const release = f.pauseReplay();
  try {
    const selectedGroup = () => f.view.querySelector<HTMLElement>('[data-primary-group-id][data-selected="true"]')!;
    await act(async () => { directory.onSelect({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'C', agentId: 'agent-C', title: 'C' }); });
    // C opens beside A with its cached content; A keeps its own conversation (rule 6).
    await settleApp(() => expect(visibleText(selectedGroup())).toContain('Cached C content'));
    expect(visibleText(selectedGroup())).not.toContain('Cached A content');
    expect(visibleText(f.view)).toContain('Cached A content');
    expect(succession.binding).toBeUndefined();
    await act(async () => { directory.onSelect({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', agentId: 'agent-D', title: 'D' }); });
    await settleApp(() => expect(succession.selected?.nativeSessionId).toBe('D'));
    expect(succession.state).toBeUndefined();
    expect(visibleText(selectedGroup())).not.toContain('Cached C content');
    await act(async () => { release(); });
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  } finally { release(); }
});

it('keeps already visible content during workspace access recovery with no usable native binding', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [], timeline: cachedConversation('A').timeline.entries });
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('A'); expect(visibleText(f.view)).toContain('Cached A content'); });
  await act(async () => f.setAccessReady(false));
  expect(succession.binding).toBeUndefined(); expect(succession.isCurrent()).toBe(false);
  expect(visibleText(f.view)).toContain('Cached A content');
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  const before = f.frames.filter(frame => frame.message?.type === 'send_message').length;
  await act(async () => f.setAccessReady(true));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toHaveLength(before);
});

it('opens predecessor A from current B, reloads its concrete history and returns to B without moving draft ownership', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const currentSlot = succession.desired!.slot.id, owners = structuredClone(succession.desired!.slot.owners);
  const oldLink = await successionHistoryLink(f.view, 'A');
  expect(new URL(oldLink.href).searchParams.get('intent')).toBe('history');
  expect(new URL(oldLink.href).searchParams.has('agent')).toBe(false);
  await act(async () => oldLink.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  expect(succession.desired!.slot.intent.kind).toBe('history');
  expect(succession.document.slots.find(slot => slot.id === currentSlot)?.owners).toEqual(owners);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('');
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await openSessions(f.view);
  const returnLink = visibleQuery<HTMLAnchorElement>(f.view, '.lab-assistant-return a')!;
  expect(returnLink.textContent).toBe('Return to current');
  expect(new URL(returnLink.href).searchParams.get('session')).toBe('B');
  expect(new URL(returnLink.href).searchParams.has('intent')).toBe(false);
  await act(async () => returnLink.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(new URL(window.location.href).searchParams.has('intent')).toBe(false);
  expect(succession.desired!.slot.id).toBe(currentSlot);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(visibleQuery(f.view, '[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.requests.some(request => request.url.endsWith('/create'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message?.type ?? ''))).toBe(false);
}, testDeadline);

it('shows A-B-C handoff history once in reverse order while ordinary A navigation still resolves current C', async () => {
  const real = successionHooks.useSessionSuccession, realHistory = historyHooks.useConversationHistory;
  let succession!: ReturnType<typeof real>, open!: Parameters<typeof realHistory>[2];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(historyHooks, 'useConversationHistory').mockImplementation((...args) => { open = args[2]; return realHistory(...args); });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('B', 'C', 3)] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  // The details list the chain newest first: C on screen, then B and A as links.
  const nav = await openSessions(f.view);
  expect([...nav.querySelectorAll<HTMLAnchorElement>('a')].map(link => new URL(link.href).searchParams.get('session'))).toEqual(['B', 'A']);
  const link = await successionHistoryLink(f.view, 'B');
  await act(async () => link.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  const current = await successionHistoryLink(f.view, 'C');
  await act(async () => current.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  const oldest = await successionHistoryLink(f.view, 'A');
  await act(async () => oldest.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const back = await successionHistoryLink(f.view, 'C');
  await act(async () => back.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId, succession.error).toBe('C'));
  await act(async () => { expect(await open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Original A link' })).toBe(true); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(new URL(window.location.href).searchParams.get('session')).toBe('C');
  expect(new URL(window.location.href).searchParams.has('intent')).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message?.type ?? ''))).toBe(false);
}, testDeadline);

it('removes handoff navigation when fresh authorized replay is denied', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  await successionHistoryLink(f.view, 'A');
  f.failReplay('succession_not_found');
  await act(async () => { await succession.refresh(); });
  expect(succession.historyNavigation).toBeUndefined();
  await settleApp(() => expect(visibleQuery(f.view, '.lab-assistant-chain a')).toBeNull());
}, testDeadline);

it('waits for the selected native successor before reporting a committed refresh complete', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const replay = committed(); f.chain.push(replay);
  const release = f.holdAttach('B');
  let outcome = 'pending', failure: unknown, pending!: Promise<void>;
  try {
    await act(async () => { pending = succession.refreshCommitted(replay.projection.receipt.operationId).then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
    await settleApp(() => expect(f.requests.some(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toBe(true));
    expect(outcome).toBe('pending');
    await act(async () => release());
    await settleApp(() => expect(outcome).toBe('confirmed'));
    await pending;
    expect(failure).toBeUndefined(); expect(succession.binding?.session.nativeSessionId).toBe('B');
  } finally { release(); }
}, testDeadline);

it('finishes committed recovery when an earlier native attachment synchronizes during replay', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  let options!: Parameters<typeof real>[0];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { options = args[0]; succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  const releaseAttach = f.holdAttach('B');
  let releaseCurrent = () => {};
  try {
    await settleApp(() => expect(f.requests.some(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toBe(true));
    releaseCurrent = f.holdCurrent();
    const currentRequests = f.requests.filter(request => request.url.includes('/session-successions/current')).length;
    let outcome = 'pending', failure: unknown;
    await act(async () => { void succession.refreshCommitted('primary-op-2').then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
    await settleApp(() => expect(f.requests.filter(request => request.url.includes('/session-successions/current')).length).toBeGreaterThan(currentRequests));
    await act(async () => releaseAttach());
    await settleApp(() => {
      const connection = options.connections.find({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B' });
      expect(connection?.replica.getState().timeline.initialized).toBe(true);
      expect(connection?.client.getSessionState().synchronized).toBe(true);
    });
    await act(async () => releaseCurrent());
    await settleApp(() => { expect(failure).toBeUndefined(); expect(outcome).toBe('confirmed'); });
    expect(succession.error).toBeUndefined(); expect(succession.binding?.session.nativeSessionId).toBe('B');
    expect(succession.document.roles[0]?.appliedRevision).toBe(2);
    expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toHaveLength(1);
  } finally { releaseAttach(); releaseCurrent(); }
}, testDeadline);

it('does not complete a committed refresh while its previously confirmed native session is restoring', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const binding = succession.binding!;
  await act(async () => f.updatesByAgent.get('agent-B')!('B', 'restoring'));
  await settleApp(() => expect(binding.client.getSessionState().recovering).toBe(true));
  let outcome = 'pending', failure: unknown;
  await act(async () => { void succession.refreshCommitted('primary-op-2').then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
  await settleApp(() => expect(succession.discovering).toBe(false));
  expect(outcome).toBe('pending');
  await act(async () => f.updatesByAgent.get('agent-B')!('B', 'connected'));
  await settleApp(() => { expect(failure).toBeUndefined(); expect(outcome).toBe('confirmed'); });
  expect(succession.binding?.client).toBe(binding.client);
}, testDeadline);

it('allows a manual refresh to confirm the retained source after a native restoration deadline', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const binding = succession.binding!, source = binding.session;
  const result: SuccessionActionResult = { role: { id: 'primary', revision: 1, origin: native('A'), current: native('A'),
    workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } },
    record: { operationId: 'cancelled-op', roleId: 'primary', expectedRevision: 1, from: native('A'), phase: 'cancelled', startedAt: 'now', updatedAt: 'now' } };
  await act(async () => f.updatesByAgent.get('agent-A')!('A', 'restoring'));
  await settleApp(() => expect(binding.client.getSessionState().recovering).toBe(true));
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
    timeout(callback, delay === 16000 ? 100 : delay, ...args)) as typeof setTimeout);
  let outcome = 'pending', failure: unknown;
  await act(async () => { void succession.refreshSettled(result, source).then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
  await settleApp(() => expect(outcome).toBe('failed'));
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('Retry the session connection');
  expect(succession.binding?.client).toBe(binding.client);
  await act(async () => f.updatesByAgent.get('agent-A')!('A', 'connected'));
  await settleApp(() => expect(binding.client.getSessionState().recovering).toBe(false));
  await act(async () => { await succession.refreshSettled(result, source); });
  expect(succession.binding?.client).toBe(binding.client);
  expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'A')).toHaveLength(1);
  expect(f.requests.some(request => /succession\/(prepare|commit)/.test(request.url))).toBe(false);
}, testDeadline);

it('keeps the last confirmed locator when a refresh after the feed reopened cannot reach the Relay', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  // The retry of a refresh that could not reach the Relay waits 1 s by default.
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation(options => { succession = real({ ...options, staleRetryDelays: [20] }); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const binding = succession.binding!, source = binding.session;
  const reads = () => f.requests.filter(item => item.url.includes('/session-successions')).length, before = reads();
  f.failReplay('network');
  await act(async () => { notifyFeedReopened(); });
  await settleApp(() => { expect(reads()).toBeGreaterThan(before); expect(succession.discovering).toBe(false); });
  // The failed refresh restores the confirmed locator without reporting a failure, but marks it stale: views keep
  // their attachment while input waits for a refresh that reaches the Relay.
  expect(() => succession.resolveTarget(source, { viewId: source.viewId })).toThrow(SessionLocatorSynchronizingError);
  expect(succession.error).toBeUndefined();
  expect(succession.result?.status).toBe('applied');
  expect(succession.binding?.client).toBe(binding.client);
  // A retry with backoff refreshes it once the Relay answers.
  f.failReplay();
  await waitFor(() => expect(succession.resolveTarget(source, { viewId: source.viewId }).target.nativeSessionId).toBe('B'));
  // A Relay answer still applies: a failed replay is reported.
  await settleApp(() => expect(succession.discovering).toBe(false));
  f.failReplay('temporary_failure');
  await act(async () => { notifyFeedReopened(); });
  await settleApp(() => expect(succession.error).toContain('Fixture succession route unavailable'));
  f.failReplay();
  expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toHaveLength(1);
}, testDeadline);

it.each(['timeout'] as const)('does not restore the confirmed locator after a refresh %s', async reason => {
  let notify: (() => void) | undefined;
  const subscribe = HttpWebSocketTransport.prototype.onSessionSuccession;
  vi.spyOn(HttpWebSocketTransport.prototype, 'onSessionSuccession').mockImplementation(function (this: HttpWebSocketTransport, listener) {
    notify = () => listener(undefined as never); return subscribe.call(this, listener);
  });
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const reads = () => f.requests.filter(item => item.url.includes('/session-successions')).length, before = reads();
  if (reason === 'timeout') {
    // A slow Relay that is online may be answering with a succession this page has not seen.
    vi.spyOn(HttpWebSocketTransport.prototype, 'fetchSessionSuccessions').mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    // Showing the page probes the channel, and the fixture never answers: the transport waits out its 4 s probe deadline, and the
    // refresh that follows retries after 1 s.
    const timeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      timeout(callback, delay === 4000 || delay === 1000 ? 20 : delay, ...args)) as typeof setTimeout);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
  } else {
    f.failReplay('network');
    await act(async () => notify!());
    await settleApp(() => expect(reads()).toBeGreaterThan(before));
  }
  // The failure is reported (with its Retry) instead of being hidden behind the old locator.
  await settleApp(() => expect(succession.error).toBeTruthy());
  expect(() => succession.resolveTarget(succession.binding?.session ?? { hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'B' })).toThrow();
  f.failReplay();
}, testDeadline);

it('retries a failed metadata refresh without retaining its old error on a healthy native binding', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const binding = succession.binding!;
  f.failReplay('temporary_failure');
  await act(async () => { await expect(succession.refreshCommitted('primary-op-2')).rejects.toThrow('Fixture succession route unavailable'); });
  f.failReplay();
  await act(async () => { await expect(succession.refreshCommitted('primary-op-2')).resolves.toBeUndefined(); });
  expect(succession.error).toBeUndefined();
  expect(succession.binding?.client).toBe(binding.client);
  expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toHaveLength(1);
}, testDeadline);

it.each(['denied', 'missing-operation', 'native-unavailable'] as const)('rejects a committed refresh with %s evidence instead of reporting success', async reason => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, reason === 'native-unavailable' ? undefined : 'B');
  await settleApp(() => reason === 'native-unavailable' ? expect(succession.error).toBe('Fixture successor unavailable.') : expect(succession.binding?.session.nativeSessionId).toBe('B'));
  if (reason === 'denied') f.failReplay('succession_not_found');
  await act(async () => { await expect(succession.refreshCommitted(reason === 'missing-operation' ? 'missing-operation' : 'primary-op-2')).rejects.toThrow(); });
}, testDeadline);

it('confirms an older committed operation after C while leaving an unrelated selected session alone', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('B', 'C', 3)] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  await act(async () => { await succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', title: 'Independent D' }); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  await act(async () => { await succession.refreshCommitted('primary-op-2'); });
  expect(succession.binding?.session.nativeSessionId).toBe('D');
  expect(succession.document.roles[0]?.appliedRevision).toBe(3);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('D');
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, testDeadline);

it('does not verify another role operation through the current historical role evidence', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('X', 'Y', 2, 'side')] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const earlier = await successionHistoryLink(f.view, 'A');
  await act(async () => earlier.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await act(async () => { await expect(succession.refreshCommitted('side-op-2')).rejects.toThrow(); });
  expect(succession.binding?.session.nativeSessionId).toBe('A');
}, testDeadline);



it.each(['primary', 'dock', 'float', 'attached'] as const)('hands off a current %s view with pending-input protection and advances every live binding', async placement => {
  const f = await windowHandoffFixture(placement);
  expect(f.target.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(true);
  await act(async () => f.target.onPendingInputChange!(1));
  await act(async () => { await f.target.onExecuteConsoleCommand!('console:handoff', ''); });
  const submit = () => document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!;
  await settleApp(() => expect(submit()).not.toBeNull());
  expect(submit().disabled).toBe(true);
  expect(document.querySelector('dialog')?.textContent).toContain('Send or remove pending messages');
  expect(f.requests.find(request => request.url.endsWith('/succession/describe'))?.body).toEqual({ providerId: 'recorded', nativeSessionId: 'X' });
  await act(async () => document.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
  await act(async () => f.target.onPendingInputChange!(0));
  await settleApp(() => expect(submit().disabled).toBe(false));
  await act(async () => document.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await settleApp(() => expect(f.target.sessionIdentity?.nativeSessionId).toBe('Y'));
  await settleApp(() => expect(f.target.pendingFirstInputContext?.state).toBe('pending'));
  await settleApp(() => expect(f.setup.windowDocument.views.filter(view => ['target', 'duplicate'].includes(view.id)).map(view => view.binding?.nativeSessionId)).toEqual(['Y', 'Y']));
  expect(f.setup.windowDocument.views.find(view => view.id === 'main')?.binding?.nativeSessionId).toBe('A');
  expect(f.setup.windowDocument.views.find(view => view.id === 'old-history')?.binding?.nativeSessionId).toBe('X');
  expect(f.setup.windowDocument.views.find(view => view.id === 'target')?.placement).toBe(placement);
  expect(f.setup.windowDocument.selectedViewId).toBe('target');
  expect(f.requests.filter(request => request.url.endsWith('/succession/prepare'))).toHaveLength(1);
  expect(f.requests.filter(request => request.url.endsWith('/succession/commit'))).toHaveLength(1);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
});

it.each(['history', 'shared'] as const)('does not offer Handoff from an ordinary window restricted by %s', async restriction => {
  const f = await windowHandoffFixture('dock', restriction);
  expect(f.target.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(false);
  await act(async () => { await expect(f.target.onExecuteConsoleCommand!('console:handoff', '')).rejects.toThrow(); });
  expect(f.requests.some(request => request.url.includes('/succession/'))).toBe(false);
});

it('opens the Handoff chooser from its command, resolves claude and sends no native input', async () => {
  const f = await handoffCommandFixture();
  expect(f.primary.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(true);
  await act(async () => { await f.primary.onExecuteConsoleCommand!('console:handoff', 'claude'); });
  await settleApp(() => expect(document.querySelector<HTMLSelectElement>('dialog [aria-label="Successor provider"]')?.value).toBe('claude-code'));
  expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(false);
  expect(f.requests.find(request => request.url.endsWith('/succession/describe'))?.body).toEqual({ providerId: 'opencode', nativeSessionId: 'A' });
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare') || request.url.endsWith('/create'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new DraftStore(f.scope).get('agent-A')).toBe('A local draft');
}, testDeadline);
