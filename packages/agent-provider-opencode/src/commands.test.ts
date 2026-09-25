import { afterEach, expect, test } from 'vitest';
import { controlsFixture } from './controls-fixture.test-utils.js';
import { OpenCodeCommands } from './commands.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(restricted = false) {
  const result = await controlsFixture(restricted); cleanups.push(() => result.close());
  return { ...result, commands: new OpenCodeCommands(result.transport, 'ses_controls', '/project') };
}

test('discovers native skills and MCP prompts with readable current documentation', async () => {
  const { commands, state } = await fixture();
  const directory = await commands.list();
  expect(directory.find(command => command.name === 'design')?.kind).toBe('skill');
  expect(directory.find(command => command.name === 'mcp-prompt')?.kind).toBe('prompt');
  expect(directory.find(command => command.name === 'check')?.inputHint).toBe('$ARGUMENTS');
  const locator = directory.find(command => command.name === 'design')!.documentation!;
  const document = await commands.readResource(locator);
  expect(document.status).toBe('available');
  if (document.status !== 'available') throw new Error('Missing native skill documentation.');
  expect(new TextDecoder().decode(document.bytes)).toContain('Base directory for this skill: /project/.opencode/skills/design');
  expect(document.mediaType).toContain('text/markdown');
  state.commands = state.commands.filter(command => command.name !== 'design');
  expect((await commands.readResource(locator)).status).toBe('unavailable');
  expect((await commands.readResource('file:///private/secret')).status).toBe('unavailable');
}, 5000);

test('invokes skill commands through native command API with the selected variant', async () => {
  const { commands, requests } = await fixture();
  await commands.execute('design', 'Build a form', { model: 'test/main', agent: 'plan', variant: 'deep' }, 'msg_skill', () => { throw new Error('Compaction model must not be requested.'); });
  expect(requests.find(request => request.method === 'POST')).toEqual({ method: 'POST', path: '/session/ses_controls/command', directory: '/project', body: { command: 'design', arguments: 'Build a form', model: 'test/main', agent: 'plan', variant: 'deep', messageID: 'msg_skill' } });
  await expect(commands.execute('unknown', '', {}, 'msg_unknown', () => ({ providerID: 'test', modelID: 'main' }))).rejects.toThrow('Unknown');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
}, 5000);

test('manual compact uses native summarize with auto false and required old-server model fields', async () => {
  const { commands, requests } = await fixture();
  const compact = (await commands.list()).find(command => command.name === 'compact')!;
  await commands.execute(compact.id, '', {}, 'msg_unused', () => ({ providerID: 'test', modelID: 'main' }));
  expect(requests.find(request => request.method === 'POST')).toEqual({ method: 'POST', path: '/session/ses_controls/summarize', directory: '/project', body: { providerID: 'test', modelID: 'main', auto: false } });
  await expect(commands.execute(compact.id, 'unexpected args', {}, 'msg_unused', () => ({ providerID: 'test', modelID: 'main' }))).rejects.toThrow('does not accept arguments');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
}, 5000);

test('does not shadow native compact commands or collide with their IDs', async () => {
  const { commands, state, requests } = await fixture();
  state.commands.push({ name: 'compact', template: 'Custom compact', source: 'command', hints: [] }, { name: 'opencode:compact', template: 'Another native command', source: 'command', hints: [] });
  const directory = await commands.list();
  const builtin = directory.find(command => command.name === 'opencode-compact')!;
  expect(builtin.id).toBe('opencode:opencode:compact');
  await commands.execute('compact', '', {}, 'msg_native', () => ({ providerID: 'test', modelID: 'main' }));
  expect(requests.find(request => request.method === 'POST')?.body.command).toBe('compact');
  await commands.execute(builtin.id, '', {}, 'msg_unused', () => ({ providerID: 'test', modelID: 'main' }));
  expect(requests.filter(request => request.method === 'POST').at(-1)?.path).toContain('/summarize');
}, 5000);

test('keeps command discovery readable while Host native execution is locked', async () => {
  const { commands, requests } = await fixture(true);
  expect((await commands.list()).length).toBeGreaterThan(0);
  await expect(commands.execute('design', '', {}, 'msg_locked', () => ({ providerID: 'test', modelID: 'main' }))).rejects.toThrow('locked');
  expect(requests.every(request => request.method === 'GET')).toBe(true);
}, 5000);
