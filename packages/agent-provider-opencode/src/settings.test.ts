import { afterEach, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { AgentSessionSetting as PublicSessionSetting } from '../../agent-remote-protocol/src/session-settings.js';
const { Value } = createRequire(new URL('../../agent-remote-protocol/package.json', import.meta.url))('@sinclair/typebox/value');
import { controlsFixture } from './controls-fixture.test-utils.js';
import { OpenCodeSettings, nativeSelections, openCodeModel, type OpenCodeSelection } from './settings.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(restricted = false) {
  const result = await controlsFixture(restricted); cleanups.push(() => result.close());
  const selected: OpenCodeSelection = { model: 'test/main', agent: 'build' };
  const settings = new OpenCodeSettings(result.transport, 'ses_controls', '/project', selected);
  await settings.refresh(); return { ...result, selected, settings };
}

test('discovers enabled models, primary agents and exact native model variants', async () => {
  const { settings, selected, requests } = await fixture();
  const initial = settings.list();
  expect(initial.find(item => item.id === 'model')?.options.map(option => option.value)).toEqual(['test/main', 'test/other']);
  expect(initial.find(item => item.id === 'agent')?.options.map(option => option.value)).toEqual(['build', 'plan']);
  expect(initial.find(item => item.id === 'variant')?.options.map(option => option.value)).toEqual(['opencode:default', 'fast', 'deep']);
  await settings.set('variant', 'deep');
  expect(selected.variant).toBe('deep');
  expect(settings.list().find(item => item.id === 'variant')?.value).toBe('deep');
  await settings.set('model', 'test/other');
  expect(selected.variant).toBeUndefined();
  expect(settings.list().some(item => item.id === 'variant')).toBe(false);
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(2);
  expect(settings.list()[0]?.description).toContain('native session');
  await expect(settings.set('model', 'offline/missing')).rejects.toThrow('Unavailable');
}, 5000);

test('writes native session permission rules while preserving native scoped rules', async () => {
  const { settings, requests, state } = await fixture();
  expect(settings.list().find(item => item.id === 'permission:bash')?.value).toBeNull();
  await settings.set('permission:bash', 'deny');
  expect(requests.find(request => request.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/session/ses_controls', directory: null, body: { permissions: [{ action: 'bash', resource: 'git *', effect: 'ask' }, { action: 'bash', resource: '*', effect: 'deny' }] } });
  expect(state.permission).toHaveLength(2);
  expect(state.permission[0]).toEqual({ action: 'bash', resource: 'git *', effect: 'ask' });
  expect(settings.list().find(item => item.id === 'permission:bash')?.value).toBe('deny');
  state.rejectUpdate = true;
  await expect(settings.set('permission:bash', 'allow')).rejects.toThrow('HTTP 500');
  expect(settings.list().find(item => item.id === 'permission:bash')?.value).toBe('deny');
}, 5000);

test('locks all mutations under Host native policy and verifies native planning agents', async () => {
  const { settings, requests } = await fixture(true);
  expect(settings.list().every(setting => !setting.mutable)).toBe(true);
  await expect(settings.set('permission:*', 'allow')).rejects.toThrow('read-only');
  expect(requests.some(request => request.method !== 'GET')).toBe(false);
  expect(settings.planningAvailable).toBe(false);
  const other = await fixture();
  expect(other.settings.planningAvailable).toBe(true);
  other.state.agents = other.state.agents.filter(agent => agent.name !== 'build');
  await other.settings.refresh();
  expect(other.settings.planningAvailable).toBe(false);
}, 5000);

test('persists model, variant and agent through native session switch routes', async () => {
  const { settings, requests, selected } = await fixture();
  await settings.set('agent', 'plan');
  await settings.set('variant', 'deep');
  const writes = requests.filter(request => request.method !== 'GET');
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body).toEqual({ agent: 'plan' });
  expect(writes[1]?.body).toEqual({ model: { id: 'main', providerID: 'test', variant: 'deep' } });
  expect(selected).toEqual({ model: 'test/main', agent: 'plan', variant: 'deep' });
  expect(settings.list()[0]?.description).toContain('native session');
}, 5000);

test('parses provider-qualified model identifiers without losing native slashes', () => {
  expect(openCodeModel('provider/model/with/slashes')).toEqual({ providerID: 'provider', modelID: 'model/with/slashes' });
  expect(() => openCodeModel('bare-model')).toThrow('provider/model');
}, 5000);

test('refresh returns native session state and accepts later permission broadcasts', async () => {
  const { settings } = await fixture();
  const native = await settings.refresh();
  expect(native.id).toBe('ses_controls');
  expect(settings.contextWindows().get('test/main')).toBe(128000);
  expect(settings.contextWindows().has('test/other')).toBe(false);
  settings.updateNative({ ...native, permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] });
  expect(settings.list().find(setting => setting.id === 'permission:edit')?.value).toBe('deny');
}, 5000);


test('does not claim rejected native selections were saved', async () => {
  const { settings, state, selected } = await fixture();
  state.rejectSwitch = true;
  await expect(settings.set('agent', 'plan')).rejects.toThrow('HTTP 409');
  await expect(settings.set('variant', 'deep')).rejects.toThrow('HTTP 409');
  expect(selected).toEqual({ model: 'test/main', agent: 'build' });
}, 5000);


test('exposes protocol-valid default variants and never sends their UI sentinel to OpenCode', async () => {
  const { settings, requests, selected } = await fixture();
  for (const setting of settings.list()) expect(Value.Check(PublicSessionSetting, setting)).toBe(true);
  const variant = settings.list().find(setting => setting.id === 'variant')!;
  expect(variant.value).toBe('opencode:default');
  const defaultValue = variant.options.find(option => option.label === 'Model default')!.value;
  expect(defaultValue.length).toBeGreaterThan(0);
  await settings.set('variant', 'deep');
  await settings.set('variant', defaultValue);
  expect(selected.variant).toBeUndefined();
  expect(requests.filter(request => request.method === 'POST').at(-1)?.body).toEqual({ model: { id: 'main', providerID: 'test' } });
  for (const setting of settings.list()) expect(Value.Check(PublicSessionSetting, setting)).toBe(true);
}, 5000);

test('external native selections replace saved choices and native variant removal clears the old value', async () => {
  const { settings, selected } = await fixture();
  const native = await settings.refresh();
  settings.updateNative({ ...native, agent: 'plan', model: { providerID: 'test', id: 'main', variant: 'deep' } });
  expect(selected).toEqual({ agent: 'plan', model: 'test/main', variant: 'deep' });
  settings.updateNative({ ...native, agent: 'build', model: { providerID: 'test', id: 'other' } });
  expect(selected).toEqual({ agent: 'build', model: 'test/other' });
  settings.updateNative(native);
  expect(selected).toEqual({ agent: 'build', model: 'test/other' });
}, 5000);


test('keeps native variants distinct from the default option sentinel', async () => {
  const { settings, state, selected, requests } = await fixture();
  state.models[0]!.variants.push({ id: 'opencode:default' });
  await settings.refresh();
  const variant = settings.list().find(setting => setting.id === 'variant')!;
  const defaults = variant.options.find(option => option.label === 'Model default')!;
  expect(defaults.value).not.toBe('opencode:default');
  await settings.set('variant', 'opencode:default');
  expect(selected.variant).toBe('opencode:default');
  expect(requests.filter(request => request.method === 'POST').at(-1)?.body.model.variant).toBe('opencode:default');
  await settings.set('variant', defaults.value);
  expect(selected.variant).toBeUndefined();
  for (const setting of settings.list()) expect(Value.Check(PublicSessionSetting, setting)).toBe(true);
}, 5000);


test('requires native session readback before publishing a model or agent selection', async () => {
  const { settings, state, selected } = await fixture();
  state.ignoreSwitch = true;
  await expect(settings.set('model', 'test/other')).rejects.toThrow(/confirm/);
  await expect(settings.set('agent', 'plan')).rejects.toThrow(/confirm/);
  expect(selected).toEqual({ model: 'test/main', agent: 'build' });
  state.ignoreSwitch = false;
  await settings.set('model', 'test/other');
  expect(selected.model).toBe('test/other');
}, 5000);


test('requires permission readback and does not publish an ignored write', async () => {
  const { settings, state } = await fixture();
  state.ignoreUpdate = true;
  await expect(settings.set('permission:bash', 'allow')).rejects.toThrow(/confirm/);
  expect(settings.list().find(item => item.id === 'permission:bash')?.value).toBeNull();
}, 5000);

test('uses native agent identities independently from display names', async () => {
  const { settings, state, requests } = await fixture();
  state.agents[0]!.id = 'agent_build';
  state.agents[1]!.id = 'agent_plan';
  state.selection.agent = 'agent_build';
  await settings.refresh();
  expect(settings.planningAgentId('build')).toBeUndefined();
  expect(settings.planningAgentId('plan')).toBeUndefined();
  expect(settings.list().find(setting => setting.id === 'agent')?.options).toContainEqual(expect.objectContaining({ value: 'agent_plan', label: 'plan' }));
  await settings.set('agent', 'agent_plan');
  expect(requests.filter(request => request.method === 'POST').at(-1)?.body).toEqual({ agent: 'agent_plan' });
  expect(settings.list().find(setting => setting.id === 'permission:edit')?.value).toBe('deny');
}, 5000);

test('recognizes built-in planning agents by native identity with capitalized display names', async () => {
  const { settings, state } = await fixture();
  state.agents[0]!.name = 'Build';
  state.agents[1]!.name = 'Plan';
  await settings.refresh();
  expect(settings.planningAvailable).toBe(true);
  expect(settings.planningAgentId('build')).toBe('build');
  expect(settings.planningAgentId('plan')).toBe('plan');
  state.agents[1]!.hidden = true;
  await settings.refresh();
  expect(settings.planningAvailable).toBe(false);
}, 5000);

test('permission overrides preserve scoped rules without accumulating duplicate overrides', async () => {
  const { settings, state } = await fixture();
  await settings.set('permission:bash', 'deny');
  await settings.set('permission:bash', 'allow');
  expect(state.permission).toEqual([{ action: 'bash', resource: 'git *', effect: 'ask' }, { action: 'bash', resource: '*', effect: 'allow' }]);
}, 5000);

test('accepts the native reserved default variant on switch readback without exposing a duplicate choice', async () => {
  const { settings, state, selected } = await fixture();
  state.explicitDefaultVariant = true;
  state.models[0]!.variants.unshift({ id: 'default' });
  await settings.refresh();
  await settings.set('model', 'test/main');
  expect(selected.variant).toBeUndefined();
  await settings.set('variant', 'deep');
  await settings.set('variant', 'opencode:default');
  expect(selected.variant).toBeUndefined();
  const native = await settings.refresh();
  native.agent = 'build';
  expect(nativeSelections(native)).toEqual({ agent: 'build', model: 'test/main' });
  expect(settings.list().find(setting => setting.id === 'variant')?.options.map(option => option.value)).toEqual(['opencode:default', 'fast', 'deep']);
}, 5000);

test('waits for a cold native model catalog before dispatching the selected model exactly once', async () => {
  const { settings, state, requests, selected } = await fixture();
  const models = state.models;
  state.models = [];
  await settings.refresh();
  const ready = setTimeout(() => { state.models = models; }, 75);
  try { await settings.set('model', 'test/other'); } finally { clearTimeout(ready); }
  expect(selected.model).toBe('test/other');
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
  expect(requests.filter(request => request.path === '/api/model').length).toBeGreaterThan(2);
}, 5000);

test('settles a missing option from observed catalogs when the final bounded read expires', async () => {
  const { settings, state, requests } = await fixture();
  const outcome = settings.set('model', 'offline/missing').then(() => undefined, error => error);
  await expect.poll(() => requests.filter(request => request.path === '/api/model').length).toBeGreaterThanOrEqual(2);
  let release!: () => void;
  state.modelReadGate = new Promise<void>(resolve => { release = resolve; });
  try {
    expect(await outcome).toMatchObject({ message: expect.stringContaining('Unavailable') });
    expect(requests.some(request => request.method === 'POST')).toBe(false);
  } finally { release(); }
}, 5000);

test('preserves real catalog failures while checking an unavailable option', async () => {
  const { settings, state, requests } = await fixture();
  const outcome = settings.set('model', 'offline/missing').then(() => undefined, error => error);
  await expect.poll(() => requests.filter(request => request.path === '/api/model').length).toBeGreaterThanOrEqual(2);
  state.rejectModelList = true;
  expect(await outcome).toMatchObject({ status: 500, message: 'OpenCode request failed (HTTP 500).' });
  expect(requests.some(request => request.method === 'POST')).toBe(false);
}, 5000);

test('keeps a catalog timeout explicit when no fresh catalog was observed', async () => {
  const { settings, state, requests } = await fixture();
  let release!: () => void;
  state.modelReadGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await expect(settings.set('model', 'offline/missing')).rejects.toThrow('OpenCode request did not complete');
    expect(requests.some(request => request.method === 'POST')).toBe(false);
  } finally { release(); }
}, 5000);
