import { createAccess } from '../access.js';
import { createBrokerState, type BrokerState } from '../broker-state.js';
import type { Binding, Host, RpcResponse } from '../broker-types.js';
import type { RouteGroup } from '../request-input.js';
import { RELAY_SOCKET_OPEN } from '../transport.js';

/**
 * A Relay account with one owner, one online Host `h1` and one guest the owner shared it with, for route-group tests: real access
 * rules over a real `BrokerState`, a Controller that records what it is asked and answers as the test says. Nothing listens or waits.
 */
export function routeFixture(options: { providers?: Host['providers'] } = {}) {
  const state: BrokerState = createBrokerState({ initialState: undefined, now: () => 1_000, keepsAssociations: false, keepsSharing: true });
  const host: Host = { id: 'h1', installationId: 'installation', name: 'Host', providers: options.providers ?? [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false,
    generation: 1, pending: new Map(), streams: new Map(), ready: true, control: true, socket: { readyState: RELAY_SOCKET_OPEN } as never };
  state.hosts.set(host.id, host);
  state.sharing.set('h1', 'guest', 'Guest', 10);
  const access = createAccess({ state, ownerSubject: 'owner' });
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  let answer: (method: string, path: string) => RpcResponse | Promise<RpcResponse> = () => ({ status: 200, body: '{}' });
  const rpc = async (_host: Host, method: 'GET' | 'POST', path: string, _sessionId?: string, body?: string) => { calls.push({ method, path, ...(body === undefined ? {} : { body }) }); return answer(method, path); };
  /** Binds a session of Host `h1` the way an attach does. */
  const bind = (agentId: string, nativeSessionId: string, creatorSubject?: string): Binding => {
    const binding = { hostId: 'h1', providerId: 'codex', nativeSessionId, agentId, generation: 1, ...(creatorSubject ? { creatorSubject } : {}) } as Binding;
    state.bindings.set(agentId, binding); state.nativeBindings.set(JSON.stringify(['h1', 'codex', nativeSessionId]), binding);
    return binding;
  };
  /** Sends a request as `subject`; `principal` is who the connection belongs to when the Controller answers (defaults to `subject`). */
  const call = async (route: RouteGroup, method: string, path: string, body?: unknown, subject = 'owner', principal: string | (() => string) = subject) => {
    const request = new Request(`https://relay.example${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await route(request, { principalSubject: () => typeof principal === "function" ? principal() : principal } as never, new URL(request.url), subject);
    return response && { status: response.status, body: await response.json() as any };
  };
  return { state, host, access, rpc, calls, bind, call, answerWith(next: typeof answer) { answer = next; } };
}
