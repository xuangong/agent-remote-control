import type { AgentCommandResult } from '@agent-remote-controller/agent-remote-protocol';
import { AgentReplica, RemoteSessionClient, type RemoteAgentTransport } from '@agent-remote-controller/agent-remote-web';
import type { LabWorkbenchActions } from './components/LabWorkbench.js';
import { captureForkContext, contextPrefix, type ForkStore, type SessionFork } from './session-forks.js';

export const forkCommands = [
  { id: 'console:fork', name: 'fork', kind: 'command' as const, description: 'Create an independent session with this conversation’s context' },
  { id: 'console:side', name: 'side', aliases: ['btw'], kind: 'command' as const, description: 'Open an independent conversation alongside this chat' },
];

export function forkActions(actions: LabWorkbenchActions, store: ForkStore, record: SessionFork | undefined, transport: RemoteAgentTransport): LabWorkbenchActions {
  if (!record?.target) return actions;
  const target = record.target;
  async function withContext<T>(text: string, send: (input: string) => Promise<T>): Promise<T | undefined> {
    await inheritSettings(actions, store, record!, transport);
    return store.send(record!.id, text, send, async () => {
      const context = await captureForkContext(transport, target);
      const rows = JSON.parse(context.text) as { role: string; text: string }[];
      return rows.some((row) => row.role === 'user' && row.text.includes(contextPrefix(record!)));
    });
  }
  return { ...actions,
    sendMessage: actions.sendMessage ? (text, options) => withContext(text, (input) => actions.sendMessage!(input, options)) : undefined,
    executeCommand: actions.executeCommand ? async (id, args): Promise<AgentCommandResult> => {
      const command = (await actions.listCommands?.())?.find((item) => item.id === id);
      return command?.kind === 'skill' || command?.kind === 'prompt'
        ? await withContext(args, (input) => actions.executeCommand!(id, input)) ?? {} : actions.executeCommand!(id, args);
    } : undefined,
  };
}

async function inheritSettings(actions: LabWorkbenchActions, store: ForkStore, record: SessionFork, transport: RemoteAgentTransport): Promise<void> {
  if (store.get(record.id).configured || !record.target) return;
  if (record.settings.length) {
    const snapshot = await transport.fetchSnapshot(record.target.agentId);
    for (const desired of record.settings) {
      const setting = snapshot.payload.runtimeInfo.settings?.find(({ id }) => id === desired.id);
      if (setting?.value === desired.value) continue;
      if (!setting?.mutable || setting.scope !== 'session' || !actions.setSessionSetting || desired.value === null) {
        throw new Error(`Cannot inherit session setting ${desired.id}. The fork has not sent any input.`);
      }
      await actions.setSessionSetting(desired.id, desired.value);
    }
  }
  store.markConfigured(record.id);
}

export async function configureFork(transport: RemoteAgentTransport, store: ForkStore, record: SessionFork): Promise<void> {
  if (store.get(record.id).configured) return;
  if (!record.settings.length) { store.markConfigured(record.id); return; }
  await withForkClient(transport, record, (client) => inheritSettings(clientActions(client), store, record, transport));
}

/** Send slash-command arguments through a short-lived observer without navigating either chat. */
export async function sendForkInput(transport: RemoteAgentTransport, store: ForkStore, record: SessionFork, text: string): Promise<void> {
  await withForkClient(transport, record, async (client) => {
    const actions = forkActions(clientActions(client), store, record, transport);
    await actions.sendMessage!(text);
  });
}
function clientActions(client: RemoteSessionClient): LabWorkbenchActions {
  return { sendMessage: async (input) => { await client.sendMessage(input); }, setSessionSetting: async (id, value) => { await client.setSessionSetting(id, value); } };
}
async function withForkClient(transport: RemoteAgentTransport, record: SessionFork, use: (client: RemoteSessionClient) => Promise<void>): Promise<void> {
  if (!record.target) throw new Error('The fork has not been created.');
  const client = new RemoteSessionClient(record.target.agentId, transport, new AgentReplica());
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The fork could not connect. Retry opening the fork.')), 15_000);
      unsubscribe = client.subscribeStatus((status) => { if (status === 'ready') resolve(); });
      client.start();
    });
    await use(client);
  } finally { clearTimeout(timer); unsubscribe?.(); client.stop(); }
}
