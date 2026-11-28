import { isBotChain, isChainThresholds, CHAIN_LIMIT, type BotChain, type ChainThresholds } from '@orchardworks/agent-remote-protocol';
import { freeze } from 'immer';
import { BrokerError, type Binding, type DeviceCredential, type Host, type RemoteHostBrokerState } from './broker-types.js';
import { HostSharing } from './host-sharing.js';
import { retainedHostIdentities, type RevokedHost } from './host-recovery.js';
import type { HostPreviewState } from './host-previews.js';
import type { SavedPairingKey } from './pairing-keys.js';
import { migrateBrokerAssociations, type BrokerAssociationState } from './succession-associations.js';
import { isSuccessionCapacityError } from './succession-capacity.js';
import { compactTeamDeliveries, TEAM_RECORD_BYTES, trimTeamDeliveryReceipts, validSavedTeam, type SavedTeam } from './team-delivery.js';

/**
 * The Relay's account state and the one way it changes. Contract:
 *
 * - It owns the records a Relay saves: device keys, Hosts, session bindings and their completed creations, pairing keys, revoked
 *   Hosts, pending journal deletions, succession associations, Teams, Call For Support, sharing, and the preview registry's snapshot.
 *   No other module keeps a copy; each reads them here.
 * - Records change in one way. A `stage` function receives a draft of the whole saved state, may throw, and returns a `publish`
 *   callback. `commit` runs stages one at a time, hands the draft to `onStateChange`, and only after that returns runs `publish`,
 *   which is the one place the live records are assigned. A stage that returns `unchanged` saves nothing.
 * - A failed save is fatal: the state becomes unavailable, every later `commit` and `assertAvailable` throw `state_unavailable`, and
 *   the listeners of `onUnavailable` run once so connections close. The state never serves from records it could not save.
 * - Live runtime fields of a Host (its socket, pending requests, streams) sit on the Host record but belong to the host session;
 *   `snapshot` copies only the fields a Host saves.
 *
 * Ports: `now` (Clock), `onStateChange` (the account's `AccountStateStore` commit).
 */
export interface BrokerState {
  readonly keys: Map<string, DeviceCredential>;
  readonly hosts: Map<string, Host>;
  readonly bindings: Map<string, Binding>;
  readonly nativeBindings: Map<string, Binding>;
  readonly completedCreations: Map<string, { fingerprint: string; agentId: string }>;
  pairings: SavedPairingKey[];
  revokedHosts: RevokedHost[] | undefined;
  journalDeletions: string[];
  associations: BrokerAssociationState;
  /** Teams are frozen committed objects; a change replaces the array. */
  teams: SavedTeam[];
  chains: BotChain[] | undefined;
  chainThresholds: ChainThresholds | undefined;
  sharing: HostSharing;
  /** The registry whose snapshot is part of the saved state; set once by the composition. */
  previews: { snapshot(): HostPreviewState[] } | undefined;
  /** Teams that passed validation; they are frozen, so they stay valid. */
  readonly validTeams: WeakSet<SavedTeam>;
  readonly unavailable: boolean;
  assertAvailable(): void;
  /** The Host is still the one registered under its id, and (with a generation) still on the connection the caller started with. */
  assertHostCurrent(host: Host, generation?: number): void;
  /** Host identities the Relay keeps for recovery, or a 409 when they no longer fit. */
  retainedIdentities(next?: BrokerAssociationState): Map<string, string>;
  commit<T>(stage: (draft: RemoteHostBrokerState) => { value: T; unchanged?: true; publish(): void }, preEffect?: boolean): Promise<T>;
  /** The state a stage starts from: copies of the live records, and the frozen ones as they are. */
  snapshot(): RemoteHostBrokerState;
  /** Marks the state unavailable and tells the listeners; a commit that failed to save does this. */
  failClosed(): void;
  onUnavailable(listener: () => void): void;
  /** Resolves when the commits queued so far have finished, whether they saved or failed. */
  settled(): Promise<void>;
  /** The Relay is shutting down: the state stops serving without telling the listeners, which the shutdown closes itself. */
  close(): void;
}

export interface BrokerStateOptions {
  initialState: RemoteHostBrokerState | undefined;
  now(): number;
  onStateChange?(state: RemoteHostBrokerState): void | Promise<void>;
  /** Whether associations are part of the saved state: succession enrollment is on, or a saved state already has them. */
  keepsAssociations: boolean;
  /** Whether the account has an owner, so sharing is part of the saved state. */
  keepsSharing: boolean;
}

export function createBrokerState(options: BrokerStateOptions): BrokerState {
  const { initialState, now } = options;
  const keys = new Map<string, DeviceCredential>();
  const hosts = new Map<string, Host>();
  for (const [hash, key] of initialState?.keys ?? []) if (key.expires > now()) keys.set(hash, structuredClone(key));
  for (const item of initialState?.hosts ?? []) hosts.set(item.id, { ...item, generation: 0, pending: new Map(), streams: new Map() });
  const bindings = new Map<string, Binding>();
  const nativeBindings = new Map<string, Binding>();
  const completedCreations = new Map<string, { fingerprint: string; agentId: string }>();
  for (const item of initialState?.bindings ?? []) {
    const binding = { ...item, generation: -1 };
    bindings.set(binding.agentId, binding);
    nativeBindings.set(JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]), binding);
  }
  for (const [key, value] of initialState?.creations ?? []) if (bindings.has(value.agentId)) completedCreations.set(key, value);
  // The chains an earlier Relay's timers began are read as routines' (a chain lasts seven days).
  const chains = initialState?.chains && structuredClone(initialState.chains).map(chain => (chain.cause as string) === 'timer' ? { ...chain, cause: 'routine' as const } : chain);
  if (chains && !validChains(chains)) throw new Error('Invalid saved chains.');
  const chainThresholds = initialState?.chainThresholds && structuredClone(initialState.chainThresholds);
  if (chainThresholds && !isChainThresholds(chainThresholds)) throw new Error('Invalid saved chain thresholds.');
  const savedTeams: SavedTeam[] = structuredClone(initialState?.teams ?? []);
  // The work items of an earlier Relay are not carried over to boards.
  for (const team of savedTeams) if (team.inbox) delete (team.inbox as { work?: unknown }).work;
  // The quiet timers of an earlier Relay are dropped: a bot with open board items gets its work routine at its next board change, and a bot sets its own again.
  for (const team of savedTeams) if (team.inbox) delete team.inbox.timers;
  if (!savedTeams.every(validSavedTeam)) throw new Error('Invalid saved Teams.');
  for (const team of savedTeams) { compactTeamDeliveries(team, now()); trimTeamDeliveryReceipts(team, TEAM_RECORD_BYTES); }

  let committedState = initialState;
  let unavailable = false;
  let commits: Promise<unknown> = Promise.resolve();
  const listeners: Array<() => void> = [];

  const state: BrokerState = {
    keys, hosts, bindings, nativeBindings, completedCreations,
    pairings: structuredClone(initialState?.pairings ?? []),
    revokedHosts: structuredClone(initialState?.revokedHosts),
    journalDeletions: [...(initialState?.journalDeletions ?? [])],
    associations: migrateBrokerAssociations(initialState?.associations ?? { version: 6, revision: 0, admissions: [], freezes: [], relationChanges: [], relationResets: [] }),
    teams: freeze(savedTeams, true),
    chains,
    chainThresholds,
    sharing: new HostSharing(initialState?.sharing, () => {}),
    previews: undefined,
    validTeams: new WeakSet<SavedTeam>(),
    get unavailable() { return unavailable; },
    assertAvailable() { if (unavailable) throw new BrokerError(503, 'state_unavailable', 'Relay state is unavailable.'); },
    assertHostCurrent(host, generation) {
      state.assertAvailable();
      if (hosts.get(host.id) !== host) throw new BrokerError(401, 'host_revoked', 'Host access was revoked.');
      if (generation !== undefined && host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Host connection changed.');
    },
    retainedIdentities(next = state.associations) {
      try { return retainedHostIdentities({ hosts: [...hosts.values()], associations: next, revokedHosts: state.revokedHosts }); }
      catch (error) { throw new BrokerError(409, 'host_recovery_capacity', error instanceof Error ? error.message : 'Retained Host identities are unavailable.'); }
    },
    snapshot() {
      return { teams: state.teams, ...(state.chains?.length ? { chains: state.chains } : {}), ...(state.chainThresholds ? { chainThresholds: state.chainThresholds } : {}), ...(state.revokedHosts ? { revokedHosts: structuredClone(state.revokedHosts) } : {}),
        ...(state.journalDeletions.length > 0 ? { journalDeletions: [...state.journalDeletions] } : {}), ...(options.keepsAssociations ? { associations: state.associations } : {}),
        pairings: structuredClone(state.pairings), previews: structuredClone(state.previews?.snapshot() ?? []), ...(options.keepsSharing ? { sharing: state.sharing.snapshot() } : {}),
        keys: [...keys].map(([key, value]) => [key, structuredClone(value)]),
        hosts: structuredClone([...hosts.values()].map(({ id, installationId, name, providers, legacyDsh, credentialRotation, gatewayKeyRequested, environment, pairingPurpose, controller, providerManagement, teamManagement, outbox, smartReading }) => ({
          ...(outbox ? { outbox } : {}), ...(smartReading ? { smartReading: [...smartReading] } : {}), ...(teamManagement ? { teamManagement } : {}),
          ...(providerManagement ? { providerManagement } : {}), ...(controller ? { controller } : {}), ...(pairingPurpose ? { pairingPurpose } : {}), ...(environment ? { environment } : {}),
          id, installationId, name, providers, legacyDsh, ...(credentialRotation ? { credentialRotation } : {}), ...(gatewayKeyRequested ? { gatewayKeyRequested } : {}) }))),
        bindings: structuredClone([...bindings.values()].map(({ generation: _generation, recovery: _recovery, ...binding }) => binding)),
        creations: structuredClone([...completedCreations]) };
    },
    commit(stage, preEffect = false) {
      const operation = commits.then(async () => {
        state.assertAvailable();
        const draft = state.snapshot();
        const result = stage(draft);
        if (result.unchanged) return result.value;
        const next = committedBrokerState(draft, committedState);
        try { await options.onStateChange?.(next); }
        catch (error) {
          if (preEffect && isSuccessionCapacityError(error)) throw new BrokerError(error.status, error.code, error.message);
          state.failClosed(); throw error;
        }
        committedState = next;
        state.assertAvailable();
        result.publish();
        return result.value;
      });
      commits = operation.catch(() => undefined);
      return operation;
    },
    failClosed() {
      if (unavailable) return;
      unavailable = true;
      for (const listener of listeners) listener();
    },
    onUnavailable(listener) { listeners.push(listener); },
    settled: () => commits.then(() => undefined),
    close() { unavailable = true; },
  };
  return state;
}


/**
 * The broker state a commit hands to the Relay. Equal entries are the previously committed objects, so they keep their
 * identity and the Relay neither encodes nor validates them again. Other entries are copies: the broker's runtime keeps
 * changing its own objects, while committed state is frozen and never changes in place.
 * Teams, Call For Support and associations are committed as they are: the broker replaces them and never changes them in place.
 */
export function committedBrokerState(next: RemoteHostBrokerState, previous: RemoteHostBrokerState | undefined): RemoteHostBrokerState {
  const result: RemoteHostBrokerState = { ...next,
    keys: retain(next.keys, previous?.keys, ([hash]) => hash)!,
    hosts: retain(next.hosts, previous?.hosts, host => host.id)!,
    bindings: retain(next.bindings, previous?.bindings, binding => binding.agentId)!,
    creations: retain(next.creations, previous?.creations, ([key]) => key)!,
  };
  if (next.pairings !== undefined) result.pairings = retain(next.pairings, previous?.pairings, pairing => pairing.id);
  if (next.revokedHosts !== undefined) result.revokedHosts = retain(next.revokedHosts, previous?.revokedHosts, host => JSON.stringify([host.hostId, host.installationId]));
  if (next.previews !== undefined) result.previews = retain(next.previews, previous?.previews, preview => preview.hostId);
  if (next.sharing !== undefined) result.sharing = { ...next.sharing,
    grants: retain(next.sharing.grants, previous?.sharing?.grants, grant => JSON.stringify([grant.hostId, grant.subject]))!,
    reservations: retain(next.sharing.reservations, previous?.sharing?.reservations, reservation => reservation.key)! };
  return result;
}

function retain<T>(values: T[] | undefined, previous: T[] | undefined, key: (value: T) => string): T[] | undefined {
  if (values === undefined) return values;
  const saved = new Map<string, T>();
  for (const value of previous ?? []) saved.set(key(value), value);
  let same = previous !== undefined && previous.length === values.length;
  const result = values.map((value, index) => {
    const prior = saved.get(key(value));
    // The same JSON is the same committed record, whatever runtime fields are left undefined.
    const kept = prior !== undefined && (prior === value || JSON.stringify(prior) === JSON.stringify(value)) ? prior : structuredClone(value);
    if (kept !== previous?.[index]) same = false;
    return kept;
  });
  return same ? previous : result;
}

/** Saved chains: at most `CHAIN_LIMIT`, each well formed, none twice. */
export function validChains(value: unknown): value is BotChain[] {
  return Array.isArray(value) && value.length <= CHAIN_LIMIT && value.every(isBotChain) && new Set(value.map(chain => chain.id)).size === value.length;
}
