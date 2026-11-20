import type { AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import { AgentReplica, RemoteOperationError, RemoteSessionClient, type RemoteAgentTransport, withMessageKey } from '@orchardworks/agent-client';
import type { LabWorkbenchActions } from './components/LabWorkbench.js';
import { captureForkContext, contextPrefix, type ForkStore, type SessionFork } from './session-forks.js';

export const askCommand = { id: 'console:ask', name: 'ask', kind: 'command' as const, description: 'Toggle global Ask view; use on/off, or add a question for this session', descriptionKey: 'client.fork.askDescription' as const };
export const forkCommands = [
  askCommand,
  { id: 'console:fork', name: 'fork', kind: 'command' as const, description: 'Create an independent session with this conversation’s context', descriptionKey: 'client.fork.forkDescription' as const },
  { id: 'console:side', name: 'side', aliases: ['btw'], kind: 'command' as const, description: 'Open an independent conversation alongside this chat', descriptionKey: 'client.fork.sideDescription' as const },
];

/**
 * `targetsFork`: whether the view these actions came from still shows the fork. A first input delayed past a change of
 * that view (its Window view rebound to the source, for instance) is rejected before dispatch as `session_changed`,
 * so the fork records it as not sent ('pending') rather than of unknown delivery.
 */
export function forkActions(actions: LabWorkbenchActions, store: ForkStore, record: SessionFork | undefined, transport: RemoteAgentTransport, targetsFork?: () => boolean): LabWorkbenchActions {
  if (!record) return actions;
  const delivery = store.getLocal(record.id) ?? (!record.remote ? record : undefined);
  if (!delivery?.target) return actions;
  record = delivery;
  const target = delivery.target;
  async function withContext<T>(text: string, dispatch: (input: string) => Promise<T>, identity?: string): Promise<T | undefined> {
    await inheritSettings(actions, store, record!, transport);
    const send = (input: string) => {
      if (targetsFork && !targetsFork()) throw new RemoteOperationError('session_changed', 'The conversation changed before this action could be sent. Return to its original session to retry.', true, undefined, 'client.fork.changedBeforeSend');
      return dispatch(input);
    };
    return store.send(record!.id, text, send, async () => {
      const context = await captureForkContext(transport, target);
      const rows = JSON.parse(context.text) as { role: string; text: string }[];
      return rows.some((row) => row.role === 'user' && row.text.includes(contextPrefix(record!)));
    }, identity, true);
  }
  return { ...actions,
    sendMessage: actions.sendMessage ? (text, options) => withContext(text, (input) => actions.sendMessage!(input, options)) : undefined,
    sendMessageContent: actions.sendMessageContent ? (content, options) => {
      const text = content.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join('');
      return withContext(text, input => {
        const prefix = input.slice(0, input.length - text.length);
        return actions.sendMessageContent!(prefix ? [{ type: 'text', text: prefix }, ...content] : content, options);
      }, JSON.stringify(content));
    } : undefined,
    executeCommand: actions.executeCommand ? async (id, args): Promise<AgentCommandResult> => {
      const command = (await actions.listCommands?.())?.find((item) => item.id === id);
      return command?.kind === 'skill' || command?.kind === 'prompt'
        ? await withContext(args, (input) => actions.executeCommand!(id, input)) ?? {} : actions.executeCommand!(id, args);
    } : undefined,
  };
}

async function inheritSettings(actions: LabWorkbenchActions, store: ForkStore, record: SessionFork, transport: RemoteAgentTransport): Promise<void> {
  const delivery = store.getLocalForEffect(record.id);
  if (!delivery) throw withMessageKey(new Error('The fork context is unavailable.'), 'client.fork.contextUnavailable');
  if (delivery.configured || !delivery.target) return;
  record = delivery;
  if (record.settings.length) {
    const snapshot = await transport.fetchSnapshot(delivery.target.agentId);
    for (const desired of record.settings) {
      const setting = snapshot.payload.runtimeInfo.settings?.find(({ id }) => id === desired.id);
      if (setting?.value === desired.value) continue;
      if (!setting?.mutable || setting.scope !== 'session' || !actions.setSessionSetting || desired.value === null) {
        throw withMessageKey(new Error(`Cannot inherit session setting ${desired.id}. The fork has not sent any input.`), 'client.fork.inheritSetting', { setting: desired.id });
      }
      await actions.setSessionSetting(desired.id, desired.value);
    }
  }
  store.markConfigured(record.id, true);
}

export async function configureFork(transport: RemoteAgentTransport, store: ForkStore, record: SessionFork, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (record.remote && !store.getLocal(record.id)) return;
  const delivery = store.getLocalForEffect(record.id);
  if (!delivery) throw withMessageKey(new Error('The fork context is unavailable.'), 'client.fork.contextUnavailable');
  if (delivery.configured) return;
  record = delivery;
  if (!record.settings.length) { store.markConfigured(record.id, true); return; }
  await withForkClient(transport, record, (client) => inheritSettings(clientActions(client), store, record, transport), signal);
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
async function withForkClient(transport: RemoteAgentTransport, record: SessionFork, use: (client: RemoteSessionClient) => Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!record.target) throw withMessageKey(new Error('The fork has not been created.'), 'client.fork.notCreated');
  const client = new RemoteSessionClient(record.target.agentId, transport, new AgentReplica());
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(withMessageKey(new Error('The fork could not connect. Retry opening the fork.'), 'client.fork.couldNotConnect')), 15_000);
      unsubscribe = client.subscribeStatus((status) => { if (status === 'ready') resolve(); });
      client.start();
    }), aborted]);
    signal?.throwIfAborted();
    await Promise.race([use(client), aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    clearTimeout(timer); unsubscribe?.(); client.stop();
  }
}
