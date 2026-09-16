import { expect, it } from 'vitest';
import type { AgentRuntimeInfo, AgentSession } from '@agent-remote-controller/agent-provider-sdk';
import { createCodexSessionDirectory } from './directory.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import { createCopilotSessionDirectory } from './copilot-directory.js';

it.each(['codex', 'claude', 'copilot'] as const)('%s reports owned runtime activity without treating closed sessions as idle', async providerId => {
  let status: AgentRuntimeInfo['status'] = 'idle';
  const session: AgentSession = {
    capabilities: {history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: {question: false, planApproval: false, toolApproval: false}},
    async *observe() { yield {type: 'history_boundary'}; },
    async sendMessage() {}, async respondToInteraction() {}, async dispose() { status = 'closed'; },
    async runtimeInfo() { return {providerId, sessionId: 'native', status, persistence: {providerId, sessionId: 'native', opaque: '{}'}}; },
  };
  const methods = {createSession: async () => session, resumeSession: async () => session, openChildSession: async () => session};
  const directory = providerId === 'codex'
    ? createCodexSessionDirectory({...methods, listSessions: async () => ({sessions: []})}, [])
    : providerId === 'claude'
      ? createClaudeSessionDirectory({...methods, listSessions: async () => []}, [])
      : createCopilotSessionDirectory({...methods, listSessions: async () => []}, []);
  try {
    await directory.open('native');
    for (const [next, expected] of [['running', 'running'], ['waiting', 'waiting'], ['idle', 'idle'], ['starting', 'unknown'], ['closed', 'unknown'], ['failed', 'unavailable']] as const) {
      status = next;
      expect(await directory.list()).toEqual([expect.objectContaining({nativeSessionId: 'native', state: expected})]);
    }
  } finally { await directory.close(); }
});
