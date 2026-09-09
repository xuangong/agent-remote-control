import { afterEach, describe, expect, it, test, vi } from 'vitest';
import {
  AGENT_REMOTE_SETTINGS_NAMESPACE,
  createRemoteHostSettings,
  watchRemoteHostSettings,
} from './agent-remote-settings.js';

interface RemoteSettings {
  serverUrl: string;
  remoteKey: string;
  instanceName: string;
}

function scope(initial: RemoteSettings) {
  let listener: ((next: RemoteSettings) => void) | undefined;
  return {
    get: () => initial,
    watch: vi.fn((next: (value: RemoteSettings) => void) => {
      listener = next;
      return () => { listener = undefined; };
    }),
    update(next: RemoteSettings) { return listener?.(next); },
  };
}

describe('Agent Remote Settings', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses explicit configuration before environment values and the device name fallback', () => {
    expect(createRemoteHostSettings({
      serverUrl: 'https://configured.example', remoteKey: 'configured-key', instanceName: 'Configured device',
    }, {
      AGENT_REMOTE_SERVER_URL: 'https://environment.example',
      AGENT_REMOTE_ACCESS_KEY: 'environment-key',
      AGENT_REMOTE_INSTANCE_NAME: 'Environment device',
    }, 'Host device')).toEqual({
      serverUrl: 'https://configured.example', remoteKey: 'configured-key', instanceName: 'Configured device',
    });
    expect(createRemoteHostSettings({}, {}, 'Host device')).toEqual({
      serverUrl: '', remoteKey: '', instanceName: 'Host device',
    });
    expect(createRemoteHostSettings({ instanceName: '' }, {
      AGENT_REMOTE_INSTANCE_NAME: 'Environment device',
    }, 'Host device')).toMatchObject({ instanceName: 'Host device' });
  });

  it('applies committed settings in order and stops watching when disposed', async () => {
    const initial = { serverUrl: 'https://first.example', remoteKey: 'first', instanceName: 'First' };
    const settingsScope = scope(initial);
    const settings = { register: vi.fn(() => settingsScope) };
    const applied: RemoteSettings[] = [];
    let releaseSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const apply = vi.fn(async (next: RemoteSettings) => {
      applied.push(next);
      if (next.serverUrl === 'https://second.example') await second;
    });

    const dispose = await watchRemoteHostSettings({ settings } as never, initial, apply, async () => undefined, {}, 'Host device');
    expect(settings.register).toHaveBeenCalledWith(
      AGENT_REMOTE_SETTINGS_NAMESPACE,
      expect.any(Function),
      expect.objectContaining({ base: initial, applies: 'live', validate: expect.any(Function) }),
    );
    expect(applied).toEqual([initial]);

    const pendingSecond = settingsScope.update({ serverUrl: 'https://second.example', remoteKey: 'second', instanceName: 'Second' });
    const pendingThird = settingsScope.update({ serverUrl: 'https://third.example', remoteKey: 'third', instanceName: 'Third' });
    await vi.waitFor(() => expect(applied).toHaveLength(2), { timeout: 1000 });
    expect(applied).toEqual([initial, { serverUrl: 'https://second.example', remoteKey: 'second', instanceName: 'Second' }]);

    releaseSecond?.();
    await Promise.all([pendingSecond, pendingThird]);
    expect(applied).toEqual([
      initial,
      { serverUrl: 'https://second.example', remoteKey: 'second', instanceName: 'Second' },
      { serverUrl: 'https://third.example', remoteKey: 'third', instanceName: 'Third' },
    ]);

    await dispose();
    await settingsScope.update({ serverUrl: 'https://ignored.example', remoteKey: 'ignored', instanceName: 'Ignored' });
    expect(applied).toHaveLength(3);
  });
});

test('waits for both Remote Host credentials before starting the uplink', async () => {
  const settingsScope = scope({ serverUrl: 'https://pair.example', remoteKey: '', instanceName: 'Host device' });
  const settings = { register: vi.fn(() => settingsScope) };
  const apply = vi.fn(async () => undefined);

  const dispose = await watchRemoteHostSettings({ settings } as never, {}, apply, async () => undefined, {}, 'Host device');
  expect(apply).not.toHaveBeenCalled();
  await settingsScope.update({ serverUrl: 'https://pair.example', remoteKey: 'paired-key', instanceName: 'Host device' });
  expect(apply).toHaveBeenCalledWith({ serverUrl: 'https://pair.example', remoteKey: 'paired-key', instanceName: 'Host device' });
  await dispose();
});

test('disconnects a running Remote Host when a saved setting becomes incomplete', async () => {
  const initial = { serverUrl: 'https://pair.example', remoteKey: 'paired-key', instanceName: 'Host device' };
  const settingsScope = scope(initial);
  const settings = { register: vi.fn(() => settingsScope) };
  const apply = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);

  const dispose = await watchRemoteHostSettings({ settings } as never, {}, apply, disconnect);
  await settingsScope.update({ ...initial, remoteKey: '' });

  expect(disconnect).toHaveBeenCalledOnce();
  await dispose();
});
