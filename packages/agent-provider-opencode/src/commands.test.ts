import { afterEach, expect, test } from 'vitest';
import { controlsFixture } from './controls-fixture.test-utils.js';
import { OpenCodeCommands } from './commands.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(restricted = false) {
  const result = await controlsFixture(restricted); cleanups.push(() => result.close());
  return { ...result, commands: new OpenCodeCommands(result.transport, 'ses_controls', '/project') };
}

test('discovers commands and skills without inventing unavailable command metadata', async () => {
  const { commands, state, requests } = await fixture();
  const directory = await commands.list();
  expect(directory.find(command => command.name === 'design')?.kind).toBe('skill');
  expect(directory.find(command => command.name === 'mcp-prompt')).toMatchObject({ kind: 'command' });
  expect(directory.find(command => command.name === 'check')?.inputHint).toBeUndefined();
  expect(directory.find(command => command.name === 'check')?.documentation).toBeUndefined();
  const locator = directory.find(command => command.name === 'design')!.documentation!;
  const document = await commands.readResource(locator);
  expect(document.status).toBe('available');
  if (document.status !== 'available') throw new Error('Missing native skill documentation.');
  expect(new TextDecoder().decode(document.bytes)).toBe('# Design\nNative instructions');
  expect(document.mediaType).toContain('text/markdown');
  state.skills = [];
  expect((await commands.readResource(locator)).status).toBe('unavailable');
  expect((await commands.readResource('file:///private/secret')).status).toBe('unavailable');
  expect(requests.every(request => request.directory === '/project')).toBe(true);
}, 5000);

test('invokes skill prompts with their native identity and command text through the v2 API', async () => {
  const { commands, requests } = await fixture();
  const skill = (await commands.list()).find(command => command.name === 'design')!;
  let dispatched = 0;
  await commands.execute(skill.id, 'Build a form', 'msg_skill', () => { dispatched++; });
  expect(requests.find(request => request.method === 'POST')).toEqual({ method: 'POST', path: '/api/session/ses_controls/prompt', directory: null, body: { id: 'msg_skill', text: 'Build a form', skills: [{ id: 'skill_design' }] } });
  await commands.execute('check', 'review this change', 'msg_command');
  expect(requests.filter(request => request.method === 'POST').at(-1)?.body).toEqual({ name: 'check', text: 'review this change' });
  await expect(commands.execute('unknown', '', 'msg_unknown')).rejects.toThrow('Unknown');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(2);
  expect(dispatched).toBe(1);
}, 5000);

test('manual compact uses the v2 inbox without requiring a separate model choice', async () => {
  const { commands, requests } = await fixture();
  const compact = (await commands.list()).find(command => command.name === 'compact')!;
  await commands.execute(compact.id, '', 'msg_compact');
  expect(requests.find(request => request.method === 'POST')).toEqual({ method: 'POST', path: '/api/session/ses_controls/compact', directory: null, body: { id: 'msg_compact' } });
  await expect(commands.execute(compact.id, 'unexpected args', 'msg_unused')).rejects.toThrow('does not accept arguments');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
}, 5000);

test('keeps colliding commands and skills independently addressable', async () => {
  const { commands, state, requests } = await fixture();
  state.commands.push({ name: 'compact' }, { name: 'opencode:compact' }, { name: 'design' });
  const directory = await commands.list();
  const builtin = directory.find(command => command.name === 'opencode-compact')!;
  expect(builtin.id).toBe('opencode:opencode:compact');
  const skill = directory.find(command => command.kind === 'skill')!;
  expect(skill.name).toBe('opencode-design');
  await commands.execute('compact', '', 'msg_native');
  expect(requests.find(request => request.method === 'POST')?.body.name).toBe('compact');
  await commands.execute(builtin.id, '', 'msg_builtin');
  expect(requests.filter(request => request.method === 'POST').at(-1)?.path).toContain('/compact');
  await commands.execute(skill.id, 'Design', 'msg_skill');
  expect(requests.filter(request => request.method === 'POST').at(-1)?.body.skills).toEqual([{ id: 'skill_design' }]);
}, 5000);

test('keeps discovery readable while Host native execution is locked', async () => {
  const { commands, requests } = await fixture(true);
  expect((await commands.list()).length).toBeGreaterThan(0);
  await expect(commands.execute('check', '', 'msg_locked')).rejects.toThrow('locked');
  expect(requests.every(request => request.method === 'GET')).toBe(true);
}, 5000);
