import { afterEach, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { AgentSessionSetting as PublicSessionSetting } from '../../agent-remote-protocol/src/session-settings.js';
const { Value } = createRequire(new URL('../../agent-remote-protocol/package.json', import.meta.url))('@sinclair/typebox/value');
import { controlsFixture } from './controls-fixture.test-utils.js';
import { OpenCodeSettings, openCodeModel, type OpenCodeSelection } from './settings.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(restricted = false) {
  const result = await controlsFixture(restricted); cleanups.push(() => result.close());
  const selected: OpenCodeSelection = { model: 'test/main', agent: 'build' };
  const settings = new OpenCodeSettings(result.transport, 'ses_controls', '/project', selected);
  await settings.refresh(); return { ...result, selected, settings };
}

test('discovers connected models, primary agents and exact native model variants', async () => {
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
  expect(requests.find(request => request.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/session/ses_controls', directory: '/project', body: { permission: [{ permission: 'bash', pattern: '*', action: 'deny' }] } });
  expect(state.permission).toHaveLength(2);
  expect(state.permission[0]).toEqual({ permission: 'bash', pattern: 'git *', action: 'ask' });
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

test('requires a concrete model for old native compact routes', async () => {
  const { settings, selected, state } = await fixture();
  expect(settings.compactionModel()).toEqual({ providerID: 'test', modelID: 'main' });
  delete selected.model;
  expect(() => settings.compactionModel()).toThrow('Choose an available');
  state.agents[0].model = { providerID: 'test', modelID: 'other' };
  await settings.refresh();
  expect(settings.compactionModel()).toEqual({ providerID: 'test', modelID: 'other' });
  expect(openCodeModel('provider/model/with/slashes')).toEqual({ providerID: 'provider', modelID: 'model/with/slashes' });
  expect(() => openCodeModel('bare-model')).toThrow('provider/model');
}, 5000);


test('refresh returns native session state and accepts later permission broadcasts', async () => {
  const { settings } = await fixture();
  const native = await settings.refresh();
  expect(native.id).toBe('ses_controls');
  expect(settings.contextWindows().get('test/main')).toBe(128000);
  expect(settings.contextWindows().has('test/other')).toBe(false);
  settings.updateNative({ ...native, permission: [{ permission: 'edit', pattern: '*', action: 'deny' }] });
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
  expect(variant.value).toBeNull();
  const defaultValue = variant.options.find(option => option.label === 'Agent/model default')!.value;
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
  Object.assign(state.providers.all[0]!.models.main.variants, { 'opencode:default': {} });
  await settings.refresh();
  const variant = settings.list().find(setting => setting.id === 'variant')!;
  const defaults = variant.options.find(option => option.label === 'Agent/model default')!;
  expect(defaults.value).not.toBe('opencode:default');
  await settings.set('variant', 'opencode:default');
  expect(selected.variant).toBe('opencode:default');
  expect(requests.filter(request => request.method === 'POST').at(-1)?.body.model.variant).toBe('opencode:default');
  await settings.set('variant', defaults.value);
  expect(selected.variant).toBeUndefined();
  for (const setting of settings.list()) expect(Value.Check(PublicSessionSetting, setting)).toBe(true);
}, 5000);
