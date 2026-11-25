import type { AgentHistoryPage, AgentHistoryQuery, AgentPersistenceHandle, AgentProviderAdapter, AgentSession, AgentSessionConfig, AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import { piBehaviour } from './behaviour.js';

export interface PiAgentProviderOptions {
  /** Path of the pi executable; resolve it with `resolvePiExecutable`. */
  executable: string;
  /** The environment pi runs in: PI_CODING_AGENT_DIR selects another profile, and the provider's credentials stay in it. */
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}
export interface PiSessionSummary { nativeSessionId: string; providerId: string; title: string; workspace?: string; createdAt: string; updatedAt: string; state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable' }

export class PiAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'pi', displayName: 'pi', behaviour: piBehaviour };
  constructor(readonly options: PiAgentProviderOptions) {}
  createSession(_config: AgentSessionConfig): Promise<AgentSession> { return Promise.reject(new Error('pi sessions are not implemented yet.')); }
  resumeSession(_handle: AgentPersistenceHandle, _extensions?: AgentSessionExtensions): Promise<AgentSession> { return Promise.reject(new Error('pi sessions are not implemented yet.')); }
  readSessionHistory(_id: string, _query: AgentHistoryQuery): Promise<AgentHistoryPage> { return Promise.reject(new Error('pi history is not implemented yet.')); }
  listSessions(): Promise<PiSessionSummary[]> { return Promise.resolve([]); }
  dispose(): Promise<void> { return Promise.resolve(); }
}
