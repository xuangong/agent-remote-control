import { hostname } from 'node:os';

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';

import type { Config } from './agent-remote.js';
import { AGENT_REMOTE_SETTINGS_NAMESPACE } from './agent-remote-settings-card.js';

export { AGENT_REMOTE_SETTINGS_NAMESPACE } from './agent-remote-settings-card.js';

export interface RemoteHostSettings {
  serverUrl: string;
  remoteKey: string;
  instanceName: string;
}

interface RemoteHostSettingsScope {
  get(): RemoteHostSettings;
  watch(callback: (next: RemoteHostSettings, previous: RemoteHostSettings) => void | Promise<void>): () => void;
}

interface SettingsContext {
  settings: {
    register<T>(namespace: string, schema: Schema<T>, options: {
      base: T;
      applies: 'live';
      validate: (value: T) => void;
    }): RemoteHostSettingsScope;
  };
}

export const RemoteHostSettingsSchema: Schema<RemoteHostSettings> = Schema.object({
  serverUrl: Schema.string().default(''),
  remoteKey: Schema.string().role('secret').default(''),
  instanceName: Schema.string().default(''),
});

export function createRemoteHostSettings(
  config: Config,
  environment: NodeJS.ProcessEnv = process.env,
  deviceName: string = hostname(),
): RemoteHostSettings {
  return {
    serverUrl: config.serverUrl ?? environment.AGENT_REMOTE_SERVER_URL ?? '',
    remoteKey: config.remoteKey ?? environment.AGENT_REMOTE_ACCESS_KEY ?? '',
    instanceName: configuredInstanceName(config.instanceName, environment.AGENT_REMOTE_INSTANCE_NAME, deviceName),
  };
}

export function validateRemoteHostSettings(settings: RemoteHostSettings): void {
  if (settings.remoteKey !== '' && (settings.remoteKey.length > 512 || !/^[!-~]+$/.test(settings.remoteKey))) {
    throw new Error('Remote Host requires a Remote Access Key without whitespace.');
  }
  if (settings.serverUrl === '') return;
  let parsed: URL;
  try {
    parsed = new URL(settings.serverUrl);
  } catch {
    throw new Error('Remote Host server URL is invalid.');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !['/', '/ws/remote-host'].includes(parsed.pathname)) {
    throw new Error('Remote Host server URL must identify the Agent Remote Control origin.');
  }
}

export async function watchRemoteHostSettings(
  context: Context & SettingsContext,
  config: Config,
  apply: (settings: RemoteHostSettings) => Promise<void>,
  disconnect: () => Promise<void>,
  environment: NodeJS.ProcessEnv = process.env,
  deviceName: string = hostname(),
): Promise<() => Promise<void>> {
  const scope = context.settings.register(
    AGENT_REMOTE_SETTINGS_NAMESPACE,
    RemoteHostSettingsSchema,
    {
      base: createRemoteHostSettings(config, environment, deviceName),
      applies: 'live',
      validate: validateRemoteHostSettings,
    },
  );
  let stopped = false;
  let connected = false;
  let tail = Promise.resolve();
  const enqueue = (next: RemoteHostSettings): Promise<void> => {
    if (stopped) return Promise.resolve();
    const operation = tail.then(async () => {
      if (stopped) return;
      if (isRemoteHostSettingsReady(next)) {
        await apply(next);
        connected = true;
        return;
      }
      if (!connected) return;
      await disconnect();
      connected = false;
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const stop = scope.watch((next) => enqueue(next));
  await enqueue(scope.get());
  return async () => {
    stopped = true;
    stop();
    await tail;
  };
}

function configuredInstanceName(configured: string | undefined, fromEnvironment: string | undefined, deviceName: string): string {
  if (configured === '') return deviceName;
  if (configured?.trim()) return configured;
  if (fromEnvironment?.trim()) return fromEnvironment;
  return deviceName;
}

function isRemoteHostSettingsReady(settings: RemoteHostSettings): boolean {
  return settings.serverUrl.trim() !== '' && settings.remoteKey.trim() !== '';
}
