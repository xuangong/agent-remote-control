import { act, useContext, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import * as workbench from './components/LabWorkbench.js';
import * as dialogs from './components/SessionSuccessionDialog.js';
import { loadSuccessionIntent } from './session-succession-intent.js';
import { SessionDirectoryClient, type SuccessionActionResult, type SuccessionDescription } from './directory-client.js';
import { SessionViewOperationsContext, type SessionViewOperations } from './session-view-operations.js';
import { botGroup, botTarget, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';
import { setPromptText } from './test/setup.js';

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
  if (change === 'deleted') changed.window.views = changed.window.views.filter(view => view.id !== 'B1');
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
  expect(app.container.querySelector('[aria-label="Bots"] [aria-current="true"]')?.getAttribute('data-bot-place')).toBe('["B","B1"]');
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
  if (change === 'deleted') changed.window.views = changed.window.views.filter(view => view.id !== 'B1');
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
      if (outcome === 'deleted view') group.window.views = group.window.views.filter(view => view.id !== 'B1');
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
  await until(() => expect(conversation().querySelector('.lab-earlier-session')?.getAttribute('aria-label')).toBe('Earlier conversation: B1'));
  await until(() => expect(app.attachments.slice(attached)).toContain('B1'));
  expect(conversation().querySelector('.lab-earlier-conversation [role="separator"]')).not.toBeNull();
  // Bot mode shows no handoff link; the earlier session is read, not opened as a view.
  expect(conversation().querySelector('.lab-succession-history')).toBeNull();
  expect(conversation().querySelector('.lab-earlier-session textarea, .lab-earlier-session [role="textbox"]')).toBeNull();
  // Info names the provider of each earlier session.
  await act(async () => app.container.querySelector<HTMLButtonElement>('button[aria-label="Bot actions: B1"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(item => item.textContent === 'Info')!.click());
  const rows = Object.fromEntries([...document.querySelectorAll('dialog .lab-bot-info dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]));
  expect(rows).toMatchObject({ Provider: 'Recorded Provider', Earlier: 'Recorded Provider' });
  await app.close();
});
