import { describe, expect, it } from 'vitest';
import type { AgentInteractionRequest, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { createCordisDshRuntime } from './runtime.js';
import { LiveDshSession } from './live-session.js';

async function host(withSkills = false) {
  const skillMessages: unknown[] = [];
  const skills = new Map([['inspect', { name: 'inspect', description: 'Inspect the workspace', invocation: { userInvocable: true }, content: '# Inspect\nNative instructions' }]]);
  let selected = { provider: 'native', model: 'a' };
  let permission = 'ask';
  let result = { kind: 'success', text: 'Native result' };
  const lines: string[] = [];
  const registry = new Map([['arbitrary', { name: 'arbitrary', description: 'Plugin command', input: { hint: 'Exact input' } }], ['permission', { name: 'permission', description: 'Native permissions' }]]);
  const agent = { status: 'idle', options: {}, session: { id: 's', header: {}, snapshotEvents: () => [], requestHeader: () => undefined }, followup(message: unknown) { if (!withSkills) throw new Error('Commands must not reach the model'); skillMessages.push(message); } };
  const services: Record<string, unknown> = {
    commands: { list: () => [...registry.values()], view: () => ({ get: (name: string) => registry.get(name) }), async execute(_agent: unknown, line: string, images: unknown[], signal: AbortSignal) {
      expect(_agent).toBe(agent); expect(images).toEqual([]); expect(signal.aborted).toBe(false);
      lines.push(line);
      if (line.startsWith('/permission ') && result.kind === 'success') permission = line.slice('/permission '.length);
      return { result };
    } },
    sessionController: { async modelCatalog() { return { groups: [{ id: 'native', models: [{ id: 'a' }, { id: 'b' }] }] }; }, async selectModel(value: typeof selected & { sessionId: string }) { expect(value.sessionId).toBe('s'); selected = { provider: value.provider, model: value.model }; } },
    agentDefaultModel: { currentSelection: () => selected },
    permissionPresets: { names: ['ask', 'auto'], current: () => permission, optionOf: (name: string) => ({ value: name, name }) },
  };
  if (withSkills) {
    services.tools = { get: (name: string, scope: unknown) => { expect(scope).toBe(agent); return name === 'skill' ? {} : undefined; } };
    services.skills = { list: async (options: { scope: unknown }) => { expect(options.scope).toBe(agent); return [...skills.values()]; },
      get: async (name: string, options: { scope: unknown }) => { expect(options.scope).toBe(agent); return skills.get(name); } };
  }
  let ask: ((request: unknown) => Promise<unknown>) | undefined;
  services.userQuestions = {};
  services.tools = { get: () => ({}), schemas: () => [] };
  const context = { sessions: { flush: async () => {} }, get: (name: string) => services[name], on: (event: string, handler: (...args: never[]) => unknown) => { if (event === 'user-questions/request') ask = handler as never; return () => {}; }, agents: { create: async () => ({ agent, dispose: async () => {} }) } };
  const runtime = createCordisDshRuntime({ context: context as never });
  const owned = await runtime.create({ sessionId: 's' });
  const session = new LiveDshSession(owned, { providerId: 'dsh', sessionId: 's', opaque: '{}' }, { get: () => undefined } as never);
  const stream = session.observe()[Symbol.asyncIterator]();
  await stream.next();
  return { session, stream, registry, lines, agent, services, skills, skillMessages, ask: (request: unknown) => ask!(request), setResult: (value: typeof result) => { result = value; }, permission: () => permission, selected: () => selected,
    async close() { await session.dispose(); await runtime.dispose?.(); } };
}
async function question(stream: AsyncIterator<unknown>): Promise<Extract<AgentInteractionRequest, { kind: 'question' }>> {
  for (;;) {
    const item = (await stream.next()).value as ProviderObservation;
    if (item.event.type === 'interaction_requested' && item.event.request.kind === 'question') return item.event.request;
  }
}

describe('native DSH commands', () => {
  it('discovers scoped skills, reads documentation, and invokes the native user gesture only on execution', async () => {
    const h = await host(true);
    try {
      const skill = (await h.session.listCommands!()).find(({ kind }) => kind === 'skill')!;
      expect(skill).toMatchObject({ name: 'inspect', documentation: 'dsh-skill:inspect' });
      expect(h.session.capabilities.readResource).toBe(true);
      const document = await h.session.readResource!(skill.documentation!);
      expect(document.status).toBe('available');
      if (document.status === 'available') expect(new TextDecoder().decode(document.bytes)).toContain('Native instructions');
      expect(h.skillMessages).toEqual([]);
      await h.session.executeCommand!(skill.id, '  check\n this  ');
      expect(h.skillMessages).toEqual([expect.objectContaining({ source: { kind: 'user' }, content: [{ type: 'text', text: '/inspect  check\n this  ' }] })]);
      expect(h.lines).toEqual([]);
      h.skills.get('inspect')!.invocation.userInvocable = false;
      expect((await h.session.listCommands!()).some(({ kind }) => kind === 'skill')).toBe(false);
      expect((await h.session.readResource!(skill.documentation!)).status).toBe('unavailable');
      await expect(h.session.executeCommand!(skill.id, '')).rejects.toThrow('unavailable');
    } finally { await h.close(); }
  });

  it('discovers dynamic plugin commands and preserves arguments without submitting a model message', async () => {
    const h = await host();
    try {
      expect(h.session.capabilities.commands).toBe(true);
      const command = (await h.session.listCommands!()).find(({ name }) => name === 'arbitrary')!;
      expect(command).toMatchObject({ name: 'arbitrary', inputHint: 'Exact input', kind: 'command' });
      await expect(h.session.executeCommand!(command.id, '  x\n y ')).resolves.toEqual({ text: 'Native result' });
      expect(h.lines).toEqual(['/arbitrary  x\n y ']);
      h.registry.delete('arbitrary');
      expect((await h.session.listCommands!()).some(({ name }) => name === 'arbitrary')).toBe(false);
      await expect(h.session.executeCommand!(command.id, '')).rejects.toThrow('unavailable');
      expect(h.lines).toHaveLength(1);
    } finally { await h.close(); }
  });

  it('surfaces native failures and routes permission choices to the native command', async () => {
    const h = await host();
    try {
      const permission = (await h.session.listCommands!()).find(({ name }) => name === 'permission')!;
      await expect(h.session.executeCommand!(permission.id, '')).resolves.toEqual({ text: 'Native result' });
      const request = await question(h.stream);
      expect(request.questions[0]!.options.map(({ value }) => value)).toEqual(['ask', 'auto']);
      h.setResult({ kind: 'error', text: 'Policy refused' });
      const response = { kind: 'question' as const, answers: [{ questionId: request.questions[0]!.questionId, selectedValues: ['auto'] }] };
      await expect(h.session.respondToInteraction(request.requestId, response)).rejects.toThrow('Policy refused');
      expect(h.permission()).toBe('ask');
      h.setResult({ kind: 'success', text: 'Permission now auto' });
      await h.session.respondToInteraction(request.requestId, response);
      expect(h.permission()).toBe('auto');
      expect(h.lines).toEqual(['/permission', '/permission auto', '/permission auto']);
    } finally { await h.close(); }
  });

  it('cancels a pending menu and rejects stale responses without blocking the next command', async () => {
    const h = await host();
    try {
      const permission = (await h.session.listCommands!()).find(({ name }) => name === 'permission')!;
      await h.session.executeCommand!(permission.id, '');
      const request = await question(h.stream);
      await h.session.cancel();
      await expect(h.session.respondToInteraction(request.requestId, { kind: 'question', answers: [], dismissed: true })).rejects.toThrow('No pending');
      await expect(h.session.executeCommand!(permission.id, 'auto')).resolves.toEqual({ text: 'Native result' });
      expect(h.permission()).toBe('auto');
    } finally { await h.close(); }
  });

  it('revalidates permissions when the plugin disappears while its menu is open', async () => {
    const h = await host();
    try {
      const permission = (await h.session.listCommands!()).find(({ name }) => name === 'permission')!;
      await h.session.executeCommand!(permission.id, '');
      const request = await question(h.stream);
      h.registry.delete('permission');
      await expect(h.session.respondToInteraction(request.requestId, { kind: 'question', answers: [{ questionId: 'permissions', selectedValues: ['auto'] }] })).rejects.toThrow('unavailable');
      expect(h.permission()).toBe('ask');
    } finally { await h.close(); }
  });

  it('accepts a native question answer while its command execution remains pending', async () => {
    const h = await host();
    try {
      h.services.commands = {
        list: () => [{ name: 'ask', description: 'Ask natively' }],
        async execute() {
          const answer = await h.ask({ agent: h.agent, questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'yes' }] }] });
          expect(answer).toEqual({ answers: [{ id: 'choice', selected: ['yes'] }] });
          return { result: { kind: 'success', text: 'Native continued' } };
        },
      };
      const command = (await h.session.listCommands!()).find(({ name }) => name === 'ask')!;
      const executing = h.session.executeCommand!(command.id, '');
      const request = await question(h.stream);
      await h.session.respondToInteraction(request.requestId, { kind: 'question', answers: [{ questionId: 'choice', selectedValues: ['yes'] }] });
      await expect(executing).resolves.toEqual({ text: 'Native continued' });
    } finally { await h.close(); }
  });

  it('rejects commands while running and invalidates menu callbacks on disposal', async () => {
    const h = await host();
    const command = (await h.session.listCommands!()).find(({ name }) => name === 'model')!;
    h.agent.status = 'running';
    await expect(h.session.executeCommand!(command.id, '')).rejects.toThrow('idle');
    h.agent.status = 'idle';
    await h.session.executeCommand!(command.id, '');
    const request = await question(h.stream);
    await h.close();
    await expect(h.session.respondToInteraction(request.requestId, { kind: 'question', answers: [{ questionId: 'model', selectedValues: ['["native","b"]'] }] })).rejects.toThrow('closed');
    expect(h.selected()).toEqual({ provider: 'native', model: 'a' });
  });

  it('lets native model registration during catalog loading take precedence', async () => {
    const h = await host();
    try {
      h.services.sessionController = {
        async modelCatalog() {
          h.registry.set('model', { name: 'model', description: 'New native model command' });
          return { groups: [{ id: 'native', models: [{ id: 'a' }] }] };
        },
        async selectModel() { throw new Error('The supplemental picker must not run'); },
      };
      const models = (await h.session.listCommands!()).filter(({ name }) => name === 'model');
      expect(models).toHaveLength(1);
      expect(models[0]!.description).toBe('New native model command');
    } finally { await h.close(); }
  });

  it('keeps pending command menus from admitting immediate or queued messages', async () => {
    const h = await host();
    const admitted: string[] = [];
    Object.assign(h.agent, { followup: () => admitted.push('followup'), steer: () => admitted.push('steer') });
    try {
      const command = (await h.session.listCommands!()).find(({ name }) => name === 'model')!;
      await h.session.executeCommand!(command.id, '');
      await question(h.stream);
      h.agent.status = 'running';
      await expect(h.session.sendMessage('immediate')).rejects.toThrow('pending');
      await expect(h.session.sendMessage('queued', { delivery: 'next_turn' })).rejects.toThrow('pending');
      expect(admitted).toEqual([]);
    } finally { await h.close(); }
  });

  it('uses native model scope and lets a registered model command override the adapter', async () => {
    const h = await host();
    try {
      const model = (await h.session.listCommands!()).find(({ name }) => name === 'model')!;
      await h.session.executeCommand!(model.id, '');
      const request = await question(h.stream);
      const choice = request.questions[0]!.options.find(({ label }) => label.endsWith('/ b'))!;
      await h.session.respondToInteraction(request.requestId, { kind: 'question', answers: [{ questionId: request.questions[0]!.questionId, selectedValues: [choice.value] }] });
      expect(h.selected()).toEqual({ provider: 'native', model: 'b' });
      h.registry.set('model', { name: 'model', description: 'Plugin model' });
      const native = (await h.session.listCommands!()).find(({ name }) => name === 'model')!;
      expect(native.description).toBe('Plugin model');
      await expect(h.session.executeCommand!(model.id, '')).rejects.toThrow('unavailable');
      await expect(h.session.executeCommand!(native.id, 'choice')).resolves.toEqual({ text: 'Native result' });
      expect(h.lines).toEqual(['/model choice']);
    } finally { await h.close(); }
  });
});
