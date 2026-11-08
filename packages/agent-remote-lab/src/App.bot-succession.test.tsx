import { act, useContext, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import * as workbench from './components/LabWorkbench.js';
import { SessionDirectoryClient, type SuccessionActionResult, type SuccessionDescription } from './directory-client.js';
import { SessionViewOperationsContext, type SessionViewOperations } from './session-view-operations.js';
import { botGroup, botTarget, mountBotApp, seedGroup, until, visibleButton } from './test/bot-mode-fixtures.js';
import { setPromptText } from './test/setup.js';

const native = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'recorded', nativeSessionId });
const description: SuccessionDescription = { role: { id: 'B-role', revision: 1, origin: native('B1'), current: native('B1'), workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } }, targets: [{ providerId: 'recorded', displayName: 'Recorded Provider' }], eligibility: { status: 'ready' } };
const response = (operationId: string, phase: SuccessionActionResult['record']['phase']): SuccessionActionResult => ({ role: description.role, record: { operationId, roleId: 'B-role', expectedRevision: 1, from: native('B1'), targetProviderId: 'recorded', phase, startedAt: 'now', updatedAt: 'now' } });
function replay(): SessionSuccessionReplay {
  const request = { operationId: 'B-to-C', roleId: 'B-role', expectedRevision: 1, from: native('B1') }, workspace = description.role.workspace;
  return { version: 1, from: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'B1' }, to: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'C' }, projection: { version: 1,
    role: { ...description.role, revision: 2, current: native('C') }, receipt: { ...request, to: native('C'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: native('C'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
}
const leaves = new Map<string, ComponentProps<typeof workbench.LabWorkbench>>();
let operations: SessionViewOperations;
beforeEach(() => {
  leaves.clear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
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
  await act(async () => app.button('B1').click());
  expect(app.container.querySelector('.lab-bot-conversation')?.textContent).toMatch(/unknown|Check|Handoff/);
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
