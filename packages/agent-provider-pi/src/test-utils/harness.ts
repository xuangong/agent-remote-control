import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession, AgentStreamEvent, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { PiAgentProvider, type PiAgentProviderOptions } from '../provider.js';
import { FakePi } from './fake-pi.js';

/** A provider over a fake pi in a temporary profile and workspace. */
export function piHarness(options: Partial<PiAgentProviderOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-fake-'));
  const agentDirectory = join(root, 'agent'), cwd = join(root, 'workspace'), work = join(root, 'work');
  for (const directory of [agentDirectory, cwd, work]) mkdirSync(directory);
  const fake = new FakePi(agentDirectory);
  const diagnostics: string[] = [];
  const provider = new PiAgentProvider({ executable: '/unused/pi', env: { PI_CODING_AGENT_DIR: agentDirectory, PI_CODING_AGENT_SESSION_DIR: undefined }, launch: fake.launcher, workRoot: work, onDiagnostic: line => diagnostics.push(line), ...options });
  return { root, agentDirectory, cwd, work, fake, provider, diagnostics, workDirectories: () => existsSync(work) ? readdirSync(work) : [],
    read: (path: string) => readFileSync(path, 'utf8'),
    async close() { await provider.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

/** Follows a session's stream in the background. */
export function follow(session: AgentSession) {
  const items: ProviderStreamItem[] = [];
  const done = (async () => { for await (const item of session.observe()) items.push(item); })().catch(error => { failure.error = error; });
  const failure: { error?: unknown } = {};
  const observations = (): ProviderObservation[] => items.filter((item): item is ProviderObservation => item.type === 'observation');
  const events = (): AgentStreamEvent[] => observations().map(({ event }) => event);
  const of = <T extends AgentStreamEvent['type']>(type: T) => events().filter((event): event is Extract<AgentStreamEvent, { type: T }> => event.type === type);
  const until = async (test: () => boolean, label = 'condition') => {
    for (let waited = 0; !test(); waited++) { if (waited > 500) throw new Error(`Timed out waiting for ${label}.`); await new Promise(resolve => setTimeout(resolve, 2)); }
  };
  return { items, done, failure, observations, events, of, until };
}

export const uiRequest = (id: string, request: unknown) => ({ type: 'extension_ui_request', id, method: 'input', title: 'arc.v1', placeholder: JSON.stringify(request) });
