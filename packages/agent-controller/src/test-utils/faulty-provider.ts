import { AgentSessionInUseError, type AgentProviderAdapter, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostProviderRegistration } from '../host.js';
import { boundary, item, ScriptedSession } from './journal-scripted-session.js';

/**
 * A provider whose native CLI misbehaves the way real CLIs do, at the provider port: the Controller's robustness is tested against it
 * with mock data. Each fault is a fact of a real CLI (section 10: O46 to O49):
 * - `writer-busy`: Codex refuses a resume while another process writes the thread ("already has an active writer");
 * - `rate-limited`: the account's usage limit, with the time after which to try again;
 * - `slow`: a resume that takes `resumeMs`, as one that starts MCP servers does;
 * - `hang`: a resume that never answers;
 * - `unknown-event`: a CLI update adds an item kind this adapter does not know.
 */
export type ProviderFault = { kind: 'writer-busy' } | { kind: 'rate-limited'; retryAfterMs: number } | { kind: 'slow'; resumeMs: number } | { kind: 'hang' } | { kind: 'unknown-event' };

export function faultyProvider(initialFault?: ProviderFault) {
  const state: { fault: ProviderFault | undefined; opens: number; opened: ScriptedSession[]; release?: () => void } = { fault: initialFault, opens: 0, opened: [] };
  const rows = (): ProviderStreamItem[] => [item('history', 'm1', 'Hello', { type: 'user_message' }), item('history', 'm2', 'World'),
    ...(state.fault?.kind === 'unknown-event' ? [newerKind()] : []), boundary()];
  /** A well-formed observation of an item kind this adapter version does not know, as a CLI update could add one. */
  const newerKind = (): ProviderStreamItem => {
    const known = item('history', 'm3', 'from a newer CLI');
    return { ...known, event: { ...(known as { event: object }).event, item: { type: 'hologram', text: 'from a newer CLI', messageId: 'm3' } } } as unknown as ProviderStreamItem;
  };
  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: 'faulty', displayName: 'Faulty' },
    journal: { itemIdentity: 1 as const },
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const directory: AgentHostDirectory = {
    providerId: 'faulty', workspaces: async () => [], create: async () => 'thread-1', canReleaseSession: () => true,
    list: async () => [{ nativeSessionId: 'thread-1', providerId: 'faulty', title: 'Thread', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), state: 'idle' as const }],
    async open(nativeSessionId) {
      state.opens += 1;
      const fault = state.fault;
      if (fault?.kind === 'writer-busy') throw new AgentSessionInUseError('This session is in use by another Codex client. Close the original Codex client, then try opening this session again.');
      // The SDK has no error for a usage limit (`AgentRuntimeError` names none), so an adapter can only pass the CLI's words on.
      if (fault?.kind === 'rate-limited') throw new Error(`Usage limit reached. Try again in ${Math.round(fault.retryAfterMs / 1000)} s.`);
      if (fault?.kind === 'hang') await new Promise<void>(resolve => { state.release = resolve; });
      if (fault?.kind === 'slow') await new Promise(resolve => setTimeout(resolve, fault.resumeMs));
      const session = new ScriptedSession('faulty', nativeSessionId, rows());
      state.opened.push(session);
      return session;
    },
    async close() { await Promise.all(state.opened.map(session => session.dispose())); },
  };
  const registration: AgentHostProviderRegistration = { adapter, directory };
  return { registration, state, /** The CLI recovers: the next resume behaves, and a hung one answers at last. */ heal() { state.fault = undefined; state.release?.(); } };
}
