import { describe, expect, it } from 'vitest';
import { DshSessionSettings } from './session-settings.js';

function fixture() {
  let selection: { provider: string; model: string; reasoningEffort?: string } = { provider: 'native', model: 'a', reasoningEffort: 'low' };
  let models: unknown[] = [
    { id: 'a', name: 'A', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Maximum', description: 'More thinking' }], defaultEffort: 'low' } },
    { id: 'b', name: 'B', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
    { id: 'plain', name: 'Plain' },
  ];
  const calls: unknown[] = [];
  const controller = {
    async modelCatalog() { return { default: selection, routableProviders: ['native'], failures: [], groups: [{ id: 'native', name: 'Native', models }] }; },
    async selectModel(request: typeof selection & { sessionId: string }) {
      calls.push(request);
      selection = { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) };
      return { selected: selection };
    },
  };
  const services: Record<string, unknown> = {
    sessionController: controller,
    sessionProjections: { stateOf: () => ({ pending: selection, lastUsed: null }) },
    agentDefaultModel: { currentSelection: () => selection },
  };
  const agent = { session: { id: 's', requestHeader: () => undefined } };
  const settings = new DshSessionSettings(agent as never, (name) => services[name]);
  return { settings, controller, calls, services, setModels: (value: unknown[]) => { models = value; }, setSelection: (value: typeof selection) => { selection = value; } };
}

describe('native model-specific reasoning effort', () => {
  it('uses native choices and submits the exact model route with session-and-default scope', async () => {
    const host = fixture();
    await host.settings.load();
    expect(host.settings.describe().find(({ id }) => id === 'effort')).toEqual({
      id: 'effort', category: 'model', label: 'Reasoning effort', value: '["native","a","low"]',
      options: [{ value: '["native","a","low"]', label: 'Low' }, { value: '["native","a","max"]', label: 'Maximum', description: 'More thinking' }],
      mutable: true, scope: 'session_and_default', description: expect.any(String),
    });
    await host.settings.select('effort', '["native","a","max"]');
    expect(host.calls).toEqual([{ sessionId: 's', provider: 'native', model: 'a', reasoningEffort: 'max' }]);
    expect(host.settings.describe().find(({ id }) => id === 'effort')?.value).toBe('["native","a","max"]');
    await host.settings.select('model', '["native","b"]');
    expect(host.settings.describe().find(({ id }) => id === 'effort')?.options).toEqual([{ value: '["native","b","high"]', label: 'High' }]);
  });

  it('rejects stale model routes and removed effort choices before calling native selection', async () => {
    const host = fixture();
    await host.settings.load();
    host.setSelection({ provider: 'native', model: 'b' });
    await expect(host.settings.select('effort', '["native","a","max"]')).rejects.toThrow();
    host.setSelection({ provider: 'native', model: 'a' });
    host.setModels([{ id: 'a', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }]);
    await expect(host.settings.select('effort', '["native","a","max"]')).rejects.toThrow();
    expect(host.calls).toEqual([]);
  });

  it('does not infer effort choices for models or hosts without native metadata', async () => {
    const host = fixture();
    host.setSelection({ provider: 'native', model: 'plain' });
    await host.settings.load();
    expect(host.settings.describe().find(({ id }) => id === 'effort')).toBeUndefined();
    delete host.services.sessionController;
    await host.settings.load();
    expect(host.settings.describe()).toEqual([]);
  });

  it('keeps the authoritative selection after native rejection instead of applying the request optimistically', async () => {
    const host = fixture();
    await host.settings.load();
    host.controller.selectModel = async () => { throw new Error('Native model unavailable'); };
    await expect(host.settings.select('effort', '["native","a","max"]')).rejects.toThrow('Native model unavailable');
    expect(host.settings.describe().find(({ id }) => id === 'effort')?.value).toBe('["native","a","low"]');
  });

  it('uses the consumed request selection after pending clears and never substitutes a catalog default', async () => {
    const host = fixture();
    host.services.sessionProjections = { stateOf: () => ({ pending: null, lastUsed: { provider: 'native', model: 'a', reasoningEffort: 'max' } }) };
    await host.settings.load();
    expect(host.settings.describe().find(({ id }) => id === 'effort')?.value).toBe('["native","a","max"]');
    host.services.sessionProjections = { stateOf: () => ({ pending: { provider: 'native', model: 'a' }, lastUsed: null }) };
    expect(host.settings.describe().find(({ id }) => id === 'effort')?.value).toBeNull();
  });
});
