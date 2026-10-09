import { bindAgentSessionTools, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';

export interface SessionHeartbeatPolicy { intervalMs?: number; waitingIntervalMs?: number; minimumIntervalMs?: number }
export function sessionHeartbeatInterval(waitingForUser: boolean, policy: SessionHeartbeatPolicy = {}): number {
  return waitingForUser ? policy.waitingIntervalMs ?? 1_800_000 : policy.intervalMs ?? 300_000;
}
export interface SessionHeartbeatAccess {
  read(): Promise<{ now: number; lastReviewAt: number; intervalMs: number; minimumIntervalMs: number }>;
  schedule(at: number, reason: string): Promise<unknown>;
}
export const sessionHeartbeatInstructions = 'Background reviews continue independently of the page. schedule_check can bring a check forward within the Host cadence. Check the current situation and act or record justified waiting. Waiting for the user is legitimate. A heartbeat is not consent and does not require sending another message.';

/** Scheduling is optional and independent of role, todo storage and native runtime ownership. */
export function sessionHeartbeatTools(access: SessionHeartbeatAccess): AgentSessionTool[] {
  return bindAgentSessionTools([{ name: 'schedule_check', description: 'Request the next background check, bounded by the Host heartbeat and minimum interval. Does not enable, reopen or unpause automation.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'integer', minimum: 30, maximum: 86400 }, reason: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['seconds', 'reason'], additionalProperties: false },
    execute: async input => {
      const { seconds, reason } = input as { seconds: number; reason: string };
      const state = await access.read();
      const at = Math.max(state.lastReviewAt + state.minimumIntervalMs, Math.min(state.now + seconds * 1000, state.now + state.intervalMs));
      return JSON.stringify(await access.schedule(at, reason));
    },
  }]);
}
