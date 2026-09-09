import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readThreadId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return readString(params.threadId);
}

export function readTurnId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const direct = readString(params.turnId);
  if (direct) return direct;
  return isRecord(params.turn) ? readString(params.turn.id) : undefined;
}

export function readItem(params: unknown): JsonObject | undefined {
  if (!isRecord(params) || !isRecord(params.item)) return undefined;
  return params.item;
}

export function readItemId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return readString(params.itemId) ?? (isRecord(params.item) ? readString(params.item.id) : undefined);
}

export function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  return readString(value.message) ?? readString(value.error);
}

export function normalizeStatus(value: unknown, lifecycle: 'started' | 'completed'):
  'running' | 'completed' | 'failed' | 'canceled' {
  if (lifecycle === 'started' || value === 'inProgress' || value === 'running') return 'running';
  if (value === 'failed') return 'failed';
  if (value === 'declined' || value === 'canceled' || value === 'cancelled' || value === 'interrupted') {
    return 'canceled';
  }
  return 'completed';
}

export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface SpawnCodexAppServerOptions {
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function spawnCodexAppServer(
  options: SpawnCodexAppServerOptions = {},
): ChildProcessWithoutNullStreams {
  return spawn(options.executable ?? 'codex', ['app-server'], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
