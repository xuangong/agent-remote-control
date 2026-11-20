import { act, useContext, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import * as workbench from './components/LabWorkbench.js';
import * as dialogs from './components/SessionSuccessionDialog.js';
import * as managerComponents from './components/ChatSessionManager.js';
import { loadSuccessionIntent } from './session-succession-intent.js';
import { SessionDirectoryClient, type SuccessionActionResult, type SuccessionDescription } from './directory-client.js';
import { SessionViewOperationsContext, type SessionViewOperations } from './session-view-operations.js';
import { botGroup, botTarget, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';
import { setPromptText } from './test/setup.js';
import { sessionKey } from './session-tree.js';

const native = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'recorded', nativeSessionId });
const description: SuccessionDescription = { role: { id: 'B-role', revision: 1, origin: native('B1'), current: native('B1'), workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } }, targets: [{ providerId: 'recorded', displayName: 'Recorded Provider' }], eligibility: { status: 'ready' } };
const response = (operationId: string, phase: SuccessionActionResult['record']['phase']): SuccessionActionResult => ({ role: description.role, record: { operationId, roleId: 'B-role', expectedRevision: 1, from: native('B1'), targetProviderId: 'recorded', phase, startedAt: 'now', updatedAt: 'now' } });
function replay(operationId = 'B-to-C'): SessionSuccessionReplay {
  const request = { operationId, roleId: 'B-role', expectedRevision: 1, from: native('B1') }, workspace = description.role.workspace;
  return { version: 1, from: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'B1' }, to: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'C' }, projection: { version: 1,
    role: { ...description.role, revision: 2, current: native('C') }, receipt: { ...request, to: native('C'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: native('C'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
}
const leaves = new Map<string, ComponentProps<typeof workbench.LabWorkbench>>();
let operations: SessionViewOperations;
beforeEach(() => {
  leaves.clear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  const Component = workbench.LabWorkbench;
  vi.spyOn(workbench, 'LabWorkbench').mockImplementation(props => {
    operations = useContext(SessionViewOperationsContext)!;
    if (props.sessionIdentity?.nativeSessionId) leaves.set(props.sessionIdentity.nativeSessionId, props);
    return <Component {...props} />;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
async function setup(name: string, holdMessages = false, sectionOnly = false) {
  const scope = `http://localhost/${name}/`, a = botGroup('A'), b = botGroup('B');
  if (sectionOnly) b.presentation = { window: false };
  seedGroup(scope, a); seedGroup(scope, b); history.replaceState(null, '', sectionOnly ? '/?mode=bot&section=B&bot=B1' : '/?window=A');
  const app = await mountBotApp(scope, { hosted: true, holdMessages });
  if (!sectionOnly) { await until(() => expect(app.workspace().hasActiveWindow).toBe(true)); await app.switchMode('bot'); await act(async () => app.button('B1').click()); }
  await until(() => expect(leaves.get('B1')?.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(true));
  return app;
}
async function openHandoff() { await act(async () => { await leaves.get('B1')!.onExecuteConsoleCommand!('console:handoff', ''); }); }

it('captures Bot B while Window A stays selected and changing bots cannot retarget its chooser', async () => {
  const described: string[] = [], prepared: string[] = [];
  vi.spyOn(SessionDirectoryClient.prototype, 'describeSuccession').mockImplementation(async (_provider, id) => { described.push(id); return description; });
  vi.spyOn(SessionDirectoryClient.prototype, 'prepareSuccession').mockImplementation(async input => { prepared.push(input.nativeSessionId); return response(input.operationId, 'unknown'); });
  vi.spyOn(SessionDirectoryClient.prototype, 'successionAction').mockImplementation(async (_action, id) => response(id, 'unknown'));
  const app = await setup('bot-handoff-source');
  const before = structuredClone(app.workspace().window);
  await openHandoff();
  await until(() => expect(document.querySelector('dialog')?.textContent).toContain('Hand off'));
  await act(async () => app.button('A1').click());
  await act(async () => visibleButton(document, 'Hand off').click());
  expect(prepared).toEqual(['B1']); expect(described).toEqual(['B1']);
  expect(app.sendMessages).toHaveLength(0); expect(app.workspace().window).toEqual(before);
  const progress = document.querySelector('.lab-handoff-notice')!;
  expect(progress.closest('[hidden]')).toBeNull();
  await app.switchMode('window'); expect(progress.closest('[hidden]')).toBeNull();
  expect(document.querySelectorAll('.lab-handoff-notice')).toHaveLength(1);
  await app.switchMode('bot');
  await act(async () => app.button('B1').click());
  expect(progress.textContent).toMatch(/unknown|Check|Handoff/);
  await app.close();
  expect(document.querySelector('.lab-handoff-notice')).toBeNull();
});

it('opens and hides a bot Handoff\'s details in Window mode while the bot\'s conversation is hidden', async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'describeSuccession').mockResolvedValue(description);
  // The Handoff stays in progress, as while the Host creates its target.
  let release = () => {};
  vi.spyOn(SessionDirectoryClient.prototype, 'prepareSuccession').mockImplementation(input => new Promise(resolve => { release = () => resolve(response(input.operationId, 'unknown')); }));
  vi.spyOn(SessionDirectoryClient.prototype, 'successionAction').mockImplementation(async (_action, id) => response(id, 'unknown'));
  const app = await setup('bot-handoff-details');
  await openHandoff();
  await until(() => expect(document.querySelector('dialog')?.textContent).toContain('Hand off'));
  await act(async () => visibleButton(document, 'Hand off').click());
  const notice = () => document.querySelector<HTMLElement>('.lab-handoff-notice')!;
  const toggle = (label: string) => [...notice().querySelectorAll('button')].find(button => button.textContent === label);
  await until(() => expect(toggle('Details') ?? toggle('Hide details')).toBeDefined());
  if (toggle('Hide details')) await act(async () => toggle('Hide details')!.click());
  // Another bot is shown, then Window mode: the source bot's conversation is hidden.
  await act(async () => app.button('B2').click());
  await app.switchMode('window');
  await act(async () => toggle('Details')!.click());
  await until(() => expect(notice().querySelector('.lab-handoff-details')).not.toBeNull());
  await act(async () => toggle('Hide details')!.click());
  await until(() => expect(notice().querySelector('.lab-handoff-details')).toBeNull());
  expect(document.querySelectorAll('.lab-handoff-notice')).toHaveLength(1);
  release();
  await app.close();
});

it("opens a Side from a bot in Bot mode, as a bot of the same group beside it", async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'create').mockResolvedValue({ agentId: 'agent-S', nativeSessionId: 'S' });
  const app = await setup('bot-side');
  const other = structuredClone(app.hostedGroups.get('A'));
  expect(leaves.get('B1')!.consoleCommands?.map(command => command.id)).toContain('console:side');
  await act(async () => { await leaves.get('B1')!.onExecuteConsoleCommand!('console:side', ''); });
  // The Side is a view of B attached to B1, so it is a bot of B with the Side role, and Bot mode shows it.
  await until(() => expect(app.hostedGroups.get('B')!.window.views.find(view => view.binding?.nativeSessionId === 'S')).toMatchObject({ placement: 'attached', attachedTo: 'B1' }));
  expect(app.hostedGroups.get('A')).toEqual(other);
  // Bot mode opens it: the Side is the current bot, listed in B's section.
  // The Side is called by the name stored with it when it was made, never by the fork's title.
  const sideB = app.hostedGroups.get('B')!.window.views.find(view => view.binding?.nativeSessionId === 'S')!;
  await until(() => expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('data-bot-place')).toBe(JSON.stringify(['B', sideB.id])));
  await until(() => expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('aria-label')).toBe(app.hostedGroups.get('B')!.bots!.members[sideB.id]?.name));
  expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('aria-label')).not.toBe('Fork of B1');
  const section = app.container.querySelector('#bot-section-B')!.closest('section')!;
  expect(section.contains(app.container.querySelector('.lab-bot-row[aria-current="true"]'))).toBe(true);
  expect(app.sendMessages).toHaveLength(0);
  await app.close();
});

it('opens a Side from a bot of the shown Window in Bot mode, and offers none to a session that is not a bot', async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'create').mockResolvedValue({ agentId: 'agent-S', nativeSessionId: 'S' });
  const app = await setup('bot-side-shown');
  await act(async () => app.button('A1').click());
  await until(() => expect(leaves.get('A1')?.consoleCommands?.map(command => command.id)).toContain('console:side'));
  await act(async () => { await leaves.get('A1')!.onExecuteConsoleCommand!('console:side', ''); });
  await until(() => expect(app.hostedGroups.get('A')!.window.views.find(view => view.binding?.nativeSessionId === 'S')).toMatchObject({ placement: 'attached', attachedTo: 'A1' }));
  // The Side is called by the name stored with it when it was made, never by the fork's title.
  const sideA = app.hostedGroups.get('A')!.window.views.find(view => view.binding?.nativeSessionId === 'S')!;
  await until(() => expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('data-bot-place')).toBe(JSON.stringify(['A', sideA.id])));
  await until(() => expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('aria-label')).toBe(app.hostedGroups.get('A')!.bots!.members[sideA.id]?.name));
  expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('aria-label')).not.toBe('Fork of A1');
  // A session listed under Other sessions has no group for a Side to join.
  const other = [...app.container.querySelectorAll<HTMLButtonElement>('.lab-bot-other .lab-bot-row')].find(button => button.getAttribute('aria-label')?.startsWith('Other'));
  expect(other).toBeDefined();
  await act(async () => other!.click());
  await until(() => expect(leaves.get('Other')?.consoleCommands).toBeDefined());
  expect(leaves.get('Other')!.consoleCommands!.map(command => command.id)).not.toContain('console:side');
  await app.close();
});

it('blocks Handoff on the exact pending Bot slot even on a section-only page', async () => {
  vi.spyOn(SessionDirectoryClient.prototype, 'describeSuccession').mockResolvedValue(description);
  const prepared: string[] = [];
  vi.spyOn(SessionDirectoryClient.prototype, 'prepareSuccession').mockImplementation(async input => { prepared.push(input.nativeSessionId); return response(input.operationId, 'unknown'); });
  const app = await setup('bot-handoff-pending', true, true);
  const input = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  await act(async () => { setPromptText(input, 'pending B'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!.disabled).toBe(false);
  await act(async () => app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!.click());
  await until(() => expect(app.sendMessages).toHaveLength(1));
  await openHandoff();
  expect(visibleButton(document, 'Hand off').disabled).toBe(true);
  expect(document.querySelector('dialog')?.textContent).toContain('pending messages');
  expect(prepared).toEqual([]); expect(app.workspace().window).toBeUndefined();
  await act(async () => app.releaseMessages()); await app.close();
});

it.each(['deleted', 'rebound'] as const)('rejects a %s Bot source after its chooser opened', async change => {
  vi.spyOn(SessionDirectoryClient.prototype, 'describeSuccession').mockResolvedValue(description);
  const prepared: string[] = [];
  vi.spyOn(SessionDirectoryClient.prototype, 'prepareSuccession').mockImplementation(async input => { prepared.push(input.nativeSessionId); return response(input.operationId, 'unknown'); });
  const app = await setup(`bot-handoff-${change}`); await openHandoff();
  const changed = structuredClone(app.hostedGroups.get('B')!); changed.window.revision++;
  if (change === 'deleted') { changed.window.views = changed.window.views.filter(view => view.id !== 'B1'); if (changed.bots) delete changed.bots.members.B1; }
  else changed.window.views[0]!.binding = botTarget('replacement');
  app.hostedGroups.set('B', changed);
  await act(async () => app.workspace().refreshGroups());
  await act(async () => visibleButton(document, 'Hand off').click());
  expect(prepared).toEqual([]); expect(document.querySelector('dialog')?.textContent).toContain('source session changed');
  await app.close();
});

it('projects a verified B to C onto the same view and draft owners while hidden pending input stays fenced', async () => {
  const app = await setup('bot-controlled-projection', true);
  const beforeWindow = structuredClone(app.workspace().window), view = leaves.get('B1')!;
  const slotId = app.succession().document.windowBindings!.find(entry => entry.windowId === 'B' && entry.viewId === 'B1')!.slotId, slot = app.succession().document.slots.find(slot => slot.id === slotId)!;
  const owners = structuredClone(slot.owners), display = structuredClone(app.workspace().readGroup('B')!.window.views[0]!.display);
  const input = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  await act(async () => { setPromptText(input, 'pending on B'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!.disabled).toBe(false);
  await act(async () => app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!.click());
  await until(() => expect(app.sendMessages).toHaveLength(1));
  await act(async () => app.button('A1').click());
  app.setReplays([replay()]);
  await act(async () => app.succession().refresh());
  expect(app.succession().error).toBeUndefined();
  await act(async () => app.button('B1').click());
  await until(() => expect(app.workspace().readGroup('B')!.window.views[0]!.binding?.nativeSessionId).toBe('C'));
  expect(app.workspace().window).toEqual(beforeWindow);
  expect(app.succession().document.slots.find(slot => slot.id === slotId)!.owners).toEqual(owners);
  expect(app.workspace().readGroup('B')!.window.views[0]!.display).toEqual(display);
  expect(app.container.querySelector('[aria-label="Assistants"] [aria-current="true"]')?.getAttribute('data-bot-place')).toBe('["B","B1"]');
  expect(() => operations.resolveTarget(botTarget('B1'), { viewId: slotId })).toThrow();
  await act(async () => app.releaseMessages());
  await until(() => expect(app.attachments).toContain('C'));
  expect(app.sendMessages.map(item => item.agentId)).toEqual(['agent-B1']);
  await app.close();
});

it.each(['deleted', 'rebound'] as const)('fences a %s hidden leaf while its original input is pending', async change => {
  const app = await setup(`bot-hidden-${change}`, true);
  const before = structuredClone(app.workspace().window);
  const slotId = app.succession().document.windowBindings!.find(entry => entry.windowId === 'B' && entry.viewId === 'B1')!.slotId;
  const input = app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  await act(async () => { setPromptText(input, 'original B input'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!.click());
  await until(() => expect(app.sendMessages).toHaveLength(1));
  await act(async () => app.button('A1').click());
  const changed = structuredClone(app.hostedGroups.get('B')!); changed.window.revision++;
  if (change === 'deleted') { changed.window.views = changed.window.views.filter(view => view.id !== 'B1'); if (changed.bots) delete changed.bots.members.B1; }
  else changed.window.views[0]!.binding = botTarget('replacement');
  app.hostedGroups.set('B', changed);
  await act(async () => app.workspace().refreshGroups());
  expect(input.isConnected).toBe(true);
  expect(input.closest('[hidden]')).not.toBeNull();
  expect(() => operations.resolveTarget(botTarget('B1'), { viewId: slotId })).toThrow(/removed|rebound|binding changed/);
  expect(app.workspace().window).toEqual(before);
  await act(async () => app.releaseMessages());
  await until(() => expect(input.isConnected).toBe(false));
  expect(app.sendMessages.map(item => item.agentId)).toEqual(['agent-B1']);
  await app.close();
});

it.each(['same successor', 'unrelated rebind', 'deleted view', 'wrong operation', 'wrong role', 'wrong revision'] as const)('validates %s when verified projection precedes the Handoff terminal response', async outcome => {
  vi.spyOn(SessionDirectoryClient.prototype, 'describeSuccession').mockResolvedValue(description);
  let settle!: ComponentProps<typeof dialogs.SessionSuccessionDialog>['onSettled'];
  const Dialog = dialogs.SessionSuccessionDialog;
  vi.spyOn(dialogs, 'SessionSuccessionDialog').mockImplementation(props => { settle = props.onSettled; return <Dialog {...props} />; });
  let operationId = '', finish!: (value: SuccessionActionResult) => void;
  vi.spyOn(SessionDirectoryClient.prototype, 'prepareSuccession').mockImplementation(async input => {
    operationId = input.operationId; return new Promise(resolve => { finish = resolve; });
  });
  const app = await setup(`bot-projection-before-response-${outcome.replaceAll(' ', '-')}`);
  try {
    const beforeWindow = structuredClone(app.workspace().window);
    const slotId = app.succession().document.windowBindings!.find(entry => entry.windowId === 'B' && entry.viewId === 'B1')!.slotId;
    const owners = structuredClone(app.succession().document.slots.find(slot => slot.id === slotId)!.owners);
    await openHandoff();
    await act(async () => visibleButton(document, 'Hand off').click());
    expect(operationId).not.toBe('');
    const evidence = replay(operationId), completed: SuccessionActionResult = { role: evidence.projection.role, record: { ...evidence.projection.receipt, targetProviderId: 'recorded' } };
    app.setReplays([evidence]);
    await act(async () => app.succession().refresh());
    await until(() => expect(app.workspace().readGroup('B')!.window.views[0]!.binding?.nativeSessionId).toBe('C'));
    if (outcome === 'unrelated rebind' || outcome === 'deleted view') {
      const group = structuredClone(app.hostedGroups.get('B')!); group.window.revision++;
      if (outcome === 'deleted view') { group.window.views = group.window.views.filter(view => view.id !== 'B1'); if (group.bots) delete group.bots.members.B1; }
      else group.window.views[0]!.binding = botTarget('unrelated');
      app.hostedGroups.set('B', group);
      await act(async () => app.workspace().refreshGroups());
    }
    const receipt = structuredClone(completed);
    if (outcome === 'wrong operation') receipt.record.operationId = 'unrelated-operation';
    if (outcome === 'wrong role') receipt.record.roleId = 'unrelated-role';
    if (outcome === 'wrong revision') receipt.record.committedRevision = 3;
    if (outcome === 'same successor') {
      await act(async () => finish(receipt));
      await until(() => expect(loadSuccessionIntent(`http://localhost/bot-projection-before-response-${outcome.replaceAll(' ', '-')}/`)).toBeUndefined());
      expect(app.container.querySelector('.lab-bot-conversation')?.textContent).not.toContain('source view changed');
      expect(app.workspace().readGroup('B')!.window.views[0]!.binding?.nativeSessionId).toBe('C');
    } else await act(async () => { await expect(settle(receipt)).rejects.toThrow(/changed|removed|rebound|confirm/); });
    expect(app.succession().document.slots.find(slot => slot.id === slotId)!.owners).toEqual(owners);
    expect(app.workspace().window).toEqual(beforeWindow); expect(app.sendMessages).toEqual([]);
  } finally { await app.close(); }
});

it('continues a handed-off bot into its earlier session above the current conversation, without announcing the handoff', async () => {
  const app = await setup('bot-earlier-session');
  const attached = app.attachments.length;
  app.setReplays([replay()]);
  await act(async () => app.succession().refresh());
  await until(() => expect(app.workspace().readGroup('B')!.window.views[0]!.binding?.nativeSessionId).toBe('C'));
  const conversation = () => app.container.querySelector('.lab-bot-conversation')!;
  // The predecessor is read again, over HTTP, above the successor's conversation.
  await until(() => expect(conversation().querySelector<HTMLElement>('.lab-earlier-session')?.dataset.session).toBe(sessionKey(botTarget('B1'))));
  await until(() => expect(app.attachments.slice(attached)).toContain('B1'));
  expect(conversation().querySelector('.lab-earlier-conversation [role="separator"]')).not.toBeNull();
  // Bot mode shows no handoff link; the earlier session is read, not opened as a view.
  expect(conversation().querySelector('.lab-succession-history')).toBeNull();
  expect(conversation().querySelector('.lab-earlier-session textarea, .lab-earlier-session [role="textbox"]')).toBeNull();
  // Its details name the agent of each earlier session.
  await until(() => expect(app.container.querySelector('.lab-assistant-details .lab-assistant-row')).not.toBeNull());
  const rows = Object.fromEntries([...app.container.querySelectorAll('.lab-assistant-details .lab-assistant-row')].map(row => [row.firstElementChild?.textContent, row.lastElementChild?.textContent]));
  expect(rows).toMatchObject({ Agent: 'Recorded Providerbefore: Recorded Provider' });
  await app.close();
});

it('continues a handed-off bot of the shown Window into its earlier session in place; Continued from reads there and never rebinds the bot', async () => {
  const scope = 'http://localhost/window-bot-earlier/'; seedGroup(scope, botGroup('A')); seedGroup(scope, botGroup('B'));
  history.replaceState(null, '', '/?window=B');
  const scrolled: string[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value(this: Element) { scrolled.push(this.getAttribute('data-session') ?? this.className); } });
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.workspace().window?.id).toBe('B'));
    await until(() => expect(leaves.get('B1')).toBeDefined());
    app.setReplays([replay()]);
    await act(async () => app.succession().refresh());
    await until(() => expect(app.workspace().readGroup('B')!.window.views[0]!.binding?.nativeSessionId).toBe('C'));
    const pane = () => app.container.querySelector<HTMLElement>('#lab-workbench [data-primary-group-id="B1"]')!;
    // As in Bot mode, the bot's conversation goes on into its earlier session, read above it: one bot, one conversation.
    await until(() => expect(pane().querySelector<HTMLElement>('.lab-earlier-session')?.dataset.session).toBe(sessionKey(botTarget('B1'))));
    // Window mode still says where the conversation came from (in words: this page never showed B1's title); the link reads
    // the earlier session where it is.
    const link = await vi.waitFor(() => { const found = pane().querySelector<HTMLAnchorElement>('.lab-succession-history a'); expect(found?.textContent).toBe('previous session'); return found!; });
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    await act(async () => {});
    expect(scrolled).toContain(sessionKey(botTarget('B1')));
    expect(pane().textContent).not.toContain('A bot keeps its conversation');
    expect(pane().querySelector('.lab-succession-history-error')).toBeNull();
    expect(app.workspace().readGroup('B')!.window.views[0]!.binding).toMatchObject({ nativeSessionId: 'C' });
    expect(app.workspace().readGroup('B')!.window.views[0]!.binding?.sessionIntent).toBeUndefined();
  } finally { delete (Element.prototype as Partial<Element>).scrollIntoView; await app.close(); }
});

it('opens a session chosen over a bot of the shown Window beside the bot rather than in its place', async () => {
  const scope = 'http://localhost/window-bot-open-beside/'; seedGroup(scope, botGroup('A'));
  history.replaceState(null, '', '/?window=A');
  const managers = new Map<string, ComponentProps<typeof managerComponents.ChatSessionManager>>(), realManager = managerComponents.ChatSessionManager;
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { managers.set(props.current.nativeSessionId, props); return realManager(props); });
  const app = await mountBotApp(scope, { hosted: true });
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await until(() => expect(managers.get('A2')).toBeDefined());
    // The pane's session list opens Other: the bot keeps its conversation, and Other opens beside it, selected.
    await act(async () => managers.get('A2')!.onOpen(botTarget('Other')));
    await until(() => expect(app.workspace().readGroup('A')!.window.views.some(view => view.binding?.nativeSessionId === 'Other')).toBe(true));
    const window = app.workspace().readGroup('A')!.window;
    expect(window.views.find(view => view.id === 'A2')!.binding).toMatchObject({ nativeSessionId: 'A2' });
    expect(window.views.find(view => view.id === window.selectedPrimaryViewId)!.binding).toMatchObject({ nativeSessionId: 'Other' });
    expect(app.container.textContent).not.toContain('A bot keeps its conversation');
  } finally { await app.close(); }
});
