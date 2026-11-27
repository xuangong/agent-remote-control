// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { DirectoryError } from '../../kernel/directory-client.js';
import { addressWithoutSession, applySessionUse, botBinding, existingBot, readSessionUseLink, type SessionUsePorts, type SessionUseRequest } from './session-use.js';

const request: SessionUseRequest = { session: { hostId: 'desk', providerId: 'claude', nativeSessionId: 'abc' }, use: { kind: 'bot', name: 'Reuse test' } };
const binding = botBinding(request, 'Reuse test', 'Native title');

function ports(overrides: Partial<SessionUsePorts> = {}) {
  const log: string[] = [];
  const value: SessionUsePorts = {
    attach: async takeOver => { log.push(`attach ${takeOver ?? ''}`.trim()); },
    existingBot: () => undefined,
    createBot: async (next, name) => { log.push(`create ${next.title} as ${name}`); return { groupId: 'g1', viewId: 'main' }; },
    show: place => { log.push(`show ${place.groupId}/${place.viewId}`); },
    ...overrides,
  };
  return { log, value };
}
const held = () => new DirectoryError('The session is open in a terminal.', 'native_session_owned', 409, undefined, { kind: 'native_cli', generation: 'gen-1' });

describe('reading a session use from an address', () => {
  it('finds the session and its use', () => {
    expect(readSessionUseLink('?host=desk&provider=claude&session=abc&as=bot&name=Reuse%20test')).toEqual(request);
    expect(readSessionUseLink('?host=desk&provider=claude&session=abc&as=bot')?.use).toEqual({ kind: 'bot' });
  });
  it('finds nothing in an ordinary session link, an invalid use or another address', () => {
    expect(readSessionUseLink('?host=desk&provider=claude&session=abc')).toBeUndefined();
    expect(readSessionUseLink('?host=desk&provider=claude&session=abc&as=other')).toBeUndefined();
    expect(readSessionUseLink('?as=bot')).toBeUndefined();
    expect(readSessionUseLink('?window=w1')).toBeUndefined();
  });
  it('removes the session and its use from the address and keeps the rest', () => {
    expect(addressWithoutSession('https://arc.example/?host=desk&provider=claude&session=abc&as=bot&name=N&window=w1')).toBe('/?window=w1');
    expect(addressWithoutSession('https://arc.example/?host=desk&provider=claude&session=abc&as=bot#x')).toBe('/#x');
  });
});

describe('applying a bot use', () => {
  it('attaches the session, then makes the bot named after the person’s choice and shows it', async () => {
    const { log, value } = ports();
    expect(await applySessionUse(request, binding, value)).toEqual({ kind: 'created' });
    expect(log).toEqual(['attach', 'create Reuse test as Reuse test', 'show g1/main']);
  });

  it('makes nothing while a native CLI holds the session, and says who holds it', async () => {
    const { log, value } = ports({ attach: async () => { throw held(); } });
    expect(await applySessionUse(request, binding, value)).toEqual({ kind: 'held', owner: { kind: 'native_cli', generation: 'gen-1' }, message: 'The session is open in a terminal.' });
    expect(log).toEqual([]);
  });

  it('takes the session over with the owner generation and then makes the bot', async () => {
    const { log, value } = ports();
    expect(await applySessionUse(request, binding, value, 'gen-1')).toEqual({ kind: 'created' });
    expect(log).toEqual(['attach gen-1', 'create Reuse test as Reuse test', 'show g1/main']);
  });

  it('shows the bot the session already is, without making another', async () => {
    const { log, value } = ports({ existingBot: () => ({ groupId: 'g0', viewId: 'v0' }) });
    expect(await applySessionUse(request, binding, value)).toEqual({ kind: 'existing' });
    expect(log).toEqual(['attach', 'show g0/v0']);
  });

  it('passes other failures on and makes nothing', async () => {
    const create = vi.fn();
    const { value } = ports({ attach: async () => { throw new DirectoryError('The Host is offline.', 'host_offline', 503); }, createBot: create });
    await expect(applySessionUse(request, binding, value)).rejects.toThrow('The Host is offline.');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('naming the bot', () => {
  it('prefers the typed name, then the session title, then its identity', () => {
    expect(botBinding(request, ' Mine ', 'Native').title).toBe('Mine');
    expect(botBinding(request, '', 'Native').title).toBe('Native');
    expect(botBinding(request, '  ', undefined).title).toBe('abc');
    expect(botBinding(request, 'x'.repeat(80), undefined).title).toHaveLength(60);
  });
});

describe('finding the bot a session already is', () => {
  const group = (id: string, withBots: boolean, bound = binding): WindowGroup => ({
    window: { id, title: 'x', views: [createWindowView('main', bound, 'primary')], selectedPrimaryViewId: 'main', selectedViewId: 'main' },
    ...(withBots ? { bots: { rank: 'a', members: { main: { picture: 'p' } } } } : {}),
  } as unknown as WindowGroup);
  it('finds it among the groups that have bots', () => {
    expect(existingBot([group('g0', true)], binding)).toEqual({ groupId: 'g0', viewId: 'main' });
  });
  it('does not take a plain Window holding the session for a bot, nor another session', () => {
    expect(existingBot([group('g0', false)], binding)).toBeUndefined();
    expect(existingBot([group('g0', true, { ...binding, nativeSessionId: 'other' })], binding)).toBeUndefined();
  });
});
