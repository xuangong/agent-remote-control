import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCodexDaemonRestart, isCodexDaemonStatus, type CodexDaemonStatus } from '@orchardworks/agent-remote-protocol';
import type { RemoteHostControlRequest } from '@orchardworks/agent-remote-relay';

export class CodexDaemonControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class CodexDaemonRestartUnknown extends Error {}

/** Records intent before dispatch. Revision checks also reject retries older than the last operation. */
export function createCodexDaemonControl(options: { stateDir: string; restart(): Promise<void> }) {
  const path = join(options.stateDir, 'codex-daemon-operation.json');
  let state: CodexDaemonStatus;
  let initialization: Promise<void> | undefined;
  let operations: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = operations.then(work); operations = result.catch(() => {}); return result;
  };
  async function save(next: CodexDaemonStatus) {
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    state = next;
  }
  async function initialize() {
    let saved: unknown;
    try { saved = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the saved Codex daemon operation. Inspect Controller storage before retrying.');
      await save({ revision: randomUUID(), phase: 'idle', updatedAt: Date.now() }); return;
    }
    if (!isCodexDaemonStatus(saved)) throw new Error('The saved Codex daemon operation is invalid. Inspect Controller storage before retrying.');
    state = saved;
    if (state.phase === 'restarting') await save({ ...state, phase: 'unknown', updatedAt: Date.now(),
      message: 'The Controller restarted before confirming the daemon operation. Inspect native state before restarting again.' });
  }
  async function status(): Promise<CodexDaemonStatus> {
    await (initialization ??= initialize()); return structuredClone(state);
  }
  async function complete(operationId: string) {
    let phase: CodexDaemonStatus['phase'] = 'ready';
    let message = 'Codex daemon is ready. Interrupted tasks do not resume automatically.';
    try { await options.restart(); }
    catch (error) {
      phase = error instanceof CodexDaemonRestartUnknown ? 'unknown' : 'failed';
      message = phase === 'unknown' ? 'The restart outcome is unknown. Inspect native state before restarting again.'
        : 'Codex did not confirm a successful restart. Check the local daemon before retrying.';
    }
    await serialize(async () => {
      if (state.operationId !== operationId) return;
      const next = { ...state, phase, message, updatedAt: Date.now() };
      try { await save(next); }
      catch { state = { ...next, phase: 'unknown', message: 'The daemon result could not be saved. Inspect Controller storage and native state.' }; }
    });
  }
  async function restart(input: unknown): Promise<CodexDaemonStatus> {
    if (!isCodexDaemonRestart(input)) throw new CodexDaemonControlError(400, 'invalid_request', 'A restart requires an operation ID and the current revision.');
    return serialize(async () => {
      await status();
      if (state.operationId === input.operationId) return structuredClone(state);
      if (input.revision !== state.revision) throw new CodexDaemonControlError(409, 'operation_conflict', 'Daemon state changed. Refresh before confirming another restart.');
      if (state.phase === 'restarting') throw new CodexDaemonControlError(409, 'operation_in_progress', 'A daemon restart is already in progress.');
      await save({ revision: randomUUID(), operationId: input.operationId, phase: 'restarting', updatedAt: Date.now() });
      const accepted = structuredClone(state);
      // Start after the accepted intent is durable; completion never depends on the requesting socket.
      void complete(input.operationId);
      return accepted;
    });
  }
  return {
    status, restart,
    async control(request: RemoteHostControlRequest) {
      try {
        const result = request.method === 'GET' ? await status() : await restart(JSON.parse(request.body ?? '{}'));
        return { status: request.method === 'POST' ? 202 : 200, body: JSON.stringify(result) };
      } catch (error) {
        return { status: error instanceof CodexDaemonControlError ? error.status : error instanceof SyntaxError ? 400 : 503,
          body: JSON.stringify({ code: error instanceof CodexDaemonControlError ? error.code : 'daemon_control_unavailable',
            error: error instanceof CodexDaemonControlError ? error.message : 'Codex daemon control is unavailable. Check Controller storage.' }) };
      }
    },
  };
}
