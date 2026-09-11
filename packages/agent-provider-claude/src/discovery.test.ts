import { describe, expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { Channel } from './channel.js';

function harness() {
  const events = new Channel<any>();
  let input: AsyncIterator<any>;
  let commands = [{ name: 'inspect', description: 'Inspect project', argumentHint: '<target>' }, { name: 'compact', description: 'Compact context', argumentHint: '' }];
  let reloads = 0;
  let release: (() => void) | undefined;
  const native = { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), initializationResult: async () => ({}),
    close: () => events.close(), interrupt: async () => {}, setPermissionMode: async () => {},
    async reloadSkills() { reloads++; if (release) await new Promise<void>((resolve) => { release = resolve; }); return { skills: commands }; },
    supportedCommands: async () => commands };
  return { events, native, factory: (args: any) => { input = args.prompt[Symbol.asyncIterator](); return native as any; },
    nextInput: () => input.next(), setCommands: (value: typeof commands) => { commands = value; }, reloads: () => reloads,
    block: () => { release = () => {}; }, unblock: () => { release?.(); release = undefined; } };
}

describe('Claude command discovery', () => {
  it('does not advertise session replacement or unsupported native control menus as skills', async () => {
    const h = harness();
    h.setCommands(['clear', 'resume', 'model', 'permissions', 'login', 'review'].map((name) => ({ name, description: '', argumentHint: '' })));
    const session = await ClaudeAgentSession.open({ sessionId: 'root' }, { query: h.factory });
    try { expect((await session.listCommands!()).map(({ name }) => name)).toEqual(['review']); }
    finally { await session.dispose(); }
  });
  it('refreshes, classifies and revalidates skills before native execution', async () => {
    const h = harness();
    const session = await ClaudeAgentSession.open({ sessionId: 'root' }, { query: h.factory });
    try {
      expect(session.capabilities.commands).toBe(true);
      const commands = await session.listCommands!();
      const skill = commands.find(({ name }) => name === 'inspect')!;
      expect(skill).toMatchObject({ kind: 'skill', inputHint: '<target>' });
      expect(skill.documentation).toBeUndefined();
      expect(commands.find(({ name }) => name === 'compact')?.kind).toBe('command');
      h.setCommands([]);
      await expect(session.executeCommand!(skill.id, 'x')).rejects.toThrow(/unavailable/);
      h.setCommands([{ name: 'inspect', description: 'New description', argumentHint: '' }]);
      await session.executeCommand!(skill.id, '  a\n b  ');
      expect((await h.nextInput()).value.message.content).toBe('/inspect   a\n b  ');
      expect(h.reloads()).toBe(3);
      await expect(session.executeCommand!(skill.id, '')).rejects.toThrow(/active|idle/);
    } finally { await session.dispose(); }
  });

  it('rejects malformed directories and serializes command execution with other input', async () => {
    const h = harness();
    const session = await ClaudeAgentSession.open({ sessionId: 'root' }, { query: h.factory });
    try {
      h.setCommands([{ name: '../unsafe', description: '', argumentHint: '' }]);
      await expect(session.listCommands!()).rejects.toThrow(/directory/);
      h.setCommands([{ name: 'inspect', description: '', argumentHint: '' }]);
      const [skill] = await session.listCommands!();
      h.block();
      const execution = session.executeCommand!(skill!.id, '');
      await expect.poll(h.reloads).toBe(3);
      await expect(session.sendMessage('race')).rejects.toThrow(/active|change/);
      await expect(session.setPlanning(true)).rejects.toThrow(/idle/);
      h.unblock(); await execution;
    } finally { h.unblock(); await session.dispose(); }
  });
});
