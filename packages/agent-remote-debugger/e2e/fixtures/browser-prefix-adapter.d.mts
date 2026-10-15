import type { DebuggerAdapter } from '../../src/server.js';
export function createBrowserPrefixAdapter(directory: string): DebuggerAdapter & {
  state(): Promise<{ creates: number; forks: number; sessions: Record<string, { texts: string[]; inputs: string[] }> }>;
  pendingInput(): string | undefined;
  settleInput(accepted: boolean): void;
  unknown(): Promise<void>;
};
