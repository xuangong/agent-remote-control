import { createHash } from 'node:crypto';

import { createAccess } from '../access.js';
import { createBrokerState, type BrokerState } from '../broker-state.js';
import type { RemoteHostBrokerState } from '../broker-types.js';
import { createExpiry } from '../credential-expiry.js';
import { createHostSession, type HostSessionGrants, type HostSessionPorts } from '../host-session.js';
import { createHostViews } from '../host-views.js';
import { sequentialRelayIds } from '../relay-ids.js';
import type { BrokerScheduler, RelaySocket } from '../transport.js';

/** A scheduler the test moves by hand: every timer of the host session fires when `advance` reaches it. */
export class ManualClock implements BrokerScheduler {
  time = 10_000;
  private nextId = 0;
  readonly timers = new Map<number, { at: number; callback(): void }>();
  setTimeout(callback: () => void, delayMs: number) { const id = ++this.nextId; this.timers.set(id, { at: this.time + delayMs, callback }); return id; }
  clearTimeout(timer: unknown) { this.timers.delete(timer as number); }
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = end;
  }
}

/** The server end of a Host's socket: it records what the Relay sends and closes, and the test feeds it the Host's frames. */
export class FakeSocket implements RelaySocket {
  readyState = 1;
  bufferedAmount: number | undefined = 0;
  readonly sent: Array<Record<string, any>> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly errors = new Set<() => void>();
  sendFailure?: 'throw' | 'error';
  private readonly messages = new Set<(data: string, binary: boolean) => void | Promise<void>>();
  private readonly closeListeners = new Set<(details?: { code?: number; wasClean?: boolean }) => void>();
  send(data: string) {
    if (this.sendFailure === 'throw') throw new Error('Transport write failed');
    this.sent.push(JSON.parse(data));
    if (this.sendFailure === 'error') for (const callback of this.errors) callback();
  }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); }
  finishClose(details?: { code?: number; wasClean?: boolean }) { this.readyState = 3; for (const callback of this.closeListeners) callback(details); }
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onClose(listener: (details?: { code?: number; wasClean?: boolean }) => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  onError(listener: () => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  async receive(message: unknown) { for (const callback of this.messages) await callback(JSON.stringify(message), false); }
  of(type: string) { return this.sent.filter(message => message.type === type); }
}

export const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');

/** The host session over a real `BrokerState`, a manual clock, and ports that do nothing: the connection alone. */
export function hostSessionFixture(options: { initialState?: RemoteHostBrokerState; onStateChange?: (state: RemoteHostBrokerState) => void | Promise<void>; heartbeat?: { intervalMs: number; timeoutMs: number };
  registrationDeadlineMs?: number; accountBacked?: boolean; ports?: Partial<HostSessionPorts> } = {}) {
  const clock = new ManualClock();
  const now = () => clock.time;
  const state: BrokerState = createBrokerState({ now, keepsAssociations: false, keepsSharing: false, ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
    initialState: options.initialState ?? { keys: [[hashOf('key'), { expires: 1_000_000, installationId: 'machine', kind: 'device' }]], hosts: [], bindings: [], creations: [] } });
  const access = createAccess({ state, ownerSubject: undefined });
  const accountBacked = options.accountBacked ?? false;
  const views = createHostViews({ brokerState: state, access, accountBacked, ownerSubject: undefined, now });
  const session = createHostSession({ brokerState: state, accountBacked, now, scheduler: clock, ids: sequentialRelayIds(), journals: undefined, journalPublished: () => undefined,
    options: { ...(options.registrationDeadlineMs === undefined ? {} : { registrationDeadlineMs: options.registrationDeadlineMs }) },
    heartbeat: options.heartbeat ?? { intervalMs: 30, timeoutMs: 10 }, keyHash: hashOf,
    deletion: { revoked: () => undefined, drain: () => undefined, deleteOne: async () => false },
    previews: { disconnect: () => undefined, update: async () => undefined } as never, teams: { hostCall: async () => ({}) } as never,
    views, expiry: createExpiry({ scheduler: clock, now }), ...options.ports });
  // The edge closes every socket it accepted when the state fails; the session ends the connections.
  const sockets = new Set<FakeSocket>();
  state.onUnavailable(() => { session.closeAll('relay_state_unavailable', 1011); for (const socket of sockets) socket.close(1011, 'Relay state is unavailable'); });
  /** Accepts a socket as the Relay does after an upgrade, and optionally sends the Host's registration. */
  async function connect(config: { register?: boolean; rotation?: boolean; grants?: HostSessionGrants; key?: string } = {}) {
    const hash = hashOf(config.key ?? 'key');
    const socket = new FakeSocket();
    sockets.add(socket);
    session.register(socket, state.keys.get(hash)!, {}, hash, { controlRequested: true, ...config.grants });
    if (config.register ?? true) await socket.receive(registration(config.rotation));
    return socket;
  }
  return { clock, state, session, connect, host: () => [...state.hosts.values()][0] };
}

export const registration = (credentialRotation = false) => ({ uplinkVersion: 2, type: 'register', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }], ...(credentialRotation ? { credentialRotation } : {}) });
