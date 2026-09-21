import {
  AgentReplica, HttpWebSocketTransport, RemoteActivityClient, RemoteSessionClient,
  type RemoteSessionStatus,
} from '@orchardworks/agent-remote-web/headless';

type Label = 'a' | 'b';
type WindowName = 'primary' | 'side';
interface Conversation {
  label: Label;
  replica: AgentReplica;
  client: RemoteSessionClient;
  status: RemoteSessionStatus;
  cleanup: (() => void)[];
}

const transport = new HttpWebSocketTransport(location.origin, { sessionChannels: true });
const ids = { a: `channel-a-${crypto.randomUUID()}`, b: `channel-b-${crypto.randomUUID()}` };
const cache = new Map<Label, AgentReplica>();
const conversations: Partial<Record<WindowName, Conversation>> = {};
const activities: RemoteActivityClient[] = [];
const activityStates = new Map<Label, string>();
const element = (id: string) => document.getElementById(id)!;
const button = (id: string) => element(id) as HTMLButtonElement;

function render(): void {
  for (const windowName of ['primary', 'side'] as const) {
    const conversation = conversations[windowName];
    element(`${windowName}-state`).textContent = conversation ? `${conversation.label}:${conversation.status}` : 'closed';
    element(`${windowName}-timeline`).textContent = conversation ? JSON.stringify(conversation.replica.getState().timeline.entries) : '';
  }
  button('send').disabled = conversations.primary?.status !== 'ready';
  element('activity-state').textContent = [...activityStates].map(([label, state]) => `${label}:${state}`).join(',');
}

function close(windowName: WindowName): void {
  const current = conversations[windowName];
  delete conversations[windowName];
  if (current) {
    for (const cleanup of current.cleanup) cleanup();
    current.client.stop();
  }
  render();
}

function open(windowName: WindowName, label: Label): void {
  close(windowName);
  let replica = cache.get(label);
  if (!replica) { replica = new AgentReplica(); cache.set(label, replica); }
  const client = new RemoteSessionClient(ids[label], transport, replica);
  const current: Conversation = { label, replica, client, status: 'idle', cleanup: [] };
  conversations[windowName] = current;
  current.cleanup.push(replica.subscribe(render), client.subscribeStatus((status) => { current.status = status; render(); }));
  client.start();
  render();
}

function dispose(): void {
  close('primary'); close('side');
  for (const activity of activities) activity.stop();
  transport.dispose();
}

function action(id: string, run: () => void | Promise<unknown>): void {
  button(id).onclick = () => { void Promise.resolve().then(run).catch((error) => { element('error').textContent = String(error); }); };
}

action('primary-a', () => open('primary', 'a'));
action('primary-b', () => open('primary', 'b'));
action('side-a', () => open('side', 'a'));
action('close-side', () => close('side'));
action('dispose', dispose);
action('send', () => conversations.primary!.client.sendMessage('Browser channel acceptance message'));
action('advance-a', async () => {
  const response = await fetch(`/v1/lab/recorded/${encodeURIComponent(ids.a)}/advance`, { method: 'POST' });
  if (!response.ok) throw new Error(`Recorded advance failed: ${response.status}`);
  element('advance-state').textContent = 'advanced';
});
window.addEventListener('pagehide', event => { if (!event.persisted) dispose(); });

async function initialize(): Promise<void> {
  await Promise.all((['a', 'b'] as const).map(label => transport.createAgent(ids[label], 'recorded', { sessionId: ids[label] })));
  element('fixture').dataset.agentA = ids.a;
  element('fixture').dataset.agentB = ids.b;
  for (const label of ['a', 'b'] as const) {
    const activity = new RemoteActivityClient(ids[label], transport, state => { activityStates.set(label, state.connection); render(); });
    activities.push(activity); activity.start();
  }
  open('primary', 'a');
  for (const control of element('fixture').querySelectorAll<HTMLButtonElement>('nav button')) control.disabled = false;
}
void initialize().catch(error => { element('error').textContent = String(error); });
