import {
  expectEqual, expectRejects, type StoreConformanceCase,
} from '@orchardworks/agent-remote-journal/testing';

import type { GatewayAuthOptions } from './auth.js';
import { buildCompleteRelayState } from './complete-relay-state.js';
import { emptyRelayState, validateRelayState, type HostedRelayState, type RelayStateStore } from './state.js';

export { buildCompleteRelayState };
export { overStructuredClone, playPartitionContract, replayPartitionContract, type PartitionContractStep } from './journal-partition-contract.js';

/** The deployment every store of the contract suite is opened for. */
export const relayStateStoreAuth: GatewayAuthOptions = {
  origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'relay-state-store-secret-0123456789012345',
};

/**
 * A store under test. `reopen` returns a store over the same storage, as a restarted process or an evicted Durable
 * Object builds it. `breakStorage` makes every later write fail and `repairStorage` undoes it.
 */
export interface RelayStateStoreUnderTest {
  store: RelayStateStore;
  reopen(): Promise<RelayStateStore>;
  breakStorage(): Promise<void>;
  repairStorage(): Promise<void>;
}

/** Keeps the committed state in memory: the `RelayStateStore` of tests and of a Relay that needs no persistence. */
export class MemoryRelayStateStore implements RelayStateStore {
  readonly initial: HostedRelayState | undefined;

  constructor(private readonly shared: { state?: HostedRelayState; broken?: true } = {}) {
    this.initial = shared.state === undefined ? undefined : structuredClone(shared.state);
  }

  async commit(state: HostedRelayState): Promise<void> {
    if (this.shared.broken) throw new Error('The memory store was broken on purpose.');
    this.shared.state = structuredClone(state);
  }

  reopen(): MemoryRelayStateStore { return new MemoryRelayStateStore(this.shared); }
  breakStorage(): void { this.shared.broken = true; }
  repairStorage(): void { delete this.shared.broken; }
}

/** The memory store as a store under test. */
export async function memoryRelayStateStoreUnderTest(): Promise<RelayStateStoreUnderTest> {
  const store = new MemoryRelayStateStore();
  return { store, reopen: async () => store.reopen(), breakStorage: async () => store.breakStorage(), repairStorage: async () => store.repairStorage() };
}

const auth = relayStateStoreAuth;
const ref = (nativeSessionId: string) => ({ hostId: 'mapped-host', providerId: 'fixture', nativeSessionId });

const initialOf = (store: RelayStateStore): HostedRelayState => validateRelayState(store.initial ?? emptyRelayState(auth), auth);

/** Commits `state`, opens a store over the same storage and checks that it starts from exactly that state. */
async function commitAndReopen(subject: RelayStateStoreUnderTest, state: HostedRelayState, what: string): Promise<RelayStateStore> {
  await subject.store.commit(state);
  const reopened = await subject.reopen();
  expectEqual(initialOf(reopened), state, what);
  return reopened;
}

/** A complete state with `change` applied, checked by the same validation a store's reader applies. */
function changed(change: (state: any) => void): HostedRelayState {
  const state: any = structuredClone(buildCompleteRelayState(auth));
  change(state);
  return validateRelayState(state, auth);
}

/**
 * The contract of a `RelayStateStore`: a commit resolves only when the whole state is durable, a store opened later
 * over the same storage starts from the last commit, and a failed commit changes nothing. Every implementation runs
 * this suite: the memory store and the Durable Object SQLite store.
 */
export const relayStateStoreCases: ReadonlyArray<StoreConformanceCase<RelayStateStoreUnderTest>> = [
  {
    name: 'starts from an empty state when nothing was committed',
    async run(open) {
      const { store, reopen } = await open();
      expectEqual(initialOf(store), emptyRelayState(auth), 'a new store');
      expectEqual(initialOf(await reopen()), emptyRelayState(auth), 'a reopened store');
    },
  },
  {
    name: 'starts from the state of its last commit, whatever kinds of records it holds',
    async run(open) {
      await commitAndReopen(await open(), buildCompleteRelayState(auth), 'the complete state');
    },
  },
  {
    name: 'replaces the stored state with the next commit',
    async run(open) {
      const subject = await open();
      await subject.store.commit(buildCompleteRelayState(auth));
      const next = changed(state => {
        state.sessionStars[0].title = 'Renamed';
        state.favoritesTrees[0].folders[0].title = 'Renamed folder';
        state.sessionTitles[0].title = 'Renamed session';
        state.tenants[0].broker.hosts[0].name = 'Renamed host';
      });
      await commitAndReopen(subject, next, 'the changed state');
    },
  },
  {
    name: 'forgets the records the next state leaves out',
    async run(open) {
      const subject = await open();
      await subject.store.commit(buildCompleteRelayState(auth));
      const next = changed(state => {
        state.sessionStars = [];
        state.sessionMigrations = [];
        state.sessionTitles = [];
        state.securityEvents = [];
        state.loginChallenges = [];
        state.consumedProofs = [];
        state.tenants = state.tenants.filter((tenant: { subject: string }) => tenant.subject !== 'viewer');
        state.tenants[0].broker.keys = [];
        state.tenants[0].broker.previews = [];
      });
      await commitAndReopen(subject, next, 'the pruned state');
    },
  },
  {
    name: 'keeps the records an unrelated commit leaves unchanged',
    async run(open) {
      const subject = await open();
      const first = buildCompleteRelayState(auth);
      await subject.store.commit(first);
      const second = changed(state => { state.securityEvents.push({ id: 'newest', subject: 'owner', at: 30, action: 'login', outcome: 'allowed' }); });
      await subject.store.commit(second);
      const restored = initialOf(await subject.reopen());
      expectEqual(restored.tenants, first.tenants, 'tenants');
      expectEqual(restored.sessionStars, first.sessionStars, 'stars');
      expectEqual(restored.securityEvents?.length, 3, 'security events');
    },
  },
  {
    name: 'accepts a commit of the state it already holds',
    async run(open) {
      const subject = await open();
      const state = buildCompleteRelayState(auth);
      await subject.store.commit(state);
      await commitAndReopen(subject, state, 'the unchanged state');
    },
  },
  {
    name: 'stores the drafts, read positions and outbox of the accounts',
    async run(open) {
      const next = changed(state => {
        state.sessionDrafts = [{ subject: 'owner', ...ref('C'), text: 'Ship the release notes', revision: 1_000 }, { subject: 'viewer', ...ref('C'), text: '', revision: 2_000 }];
        state.sessionReadAccounts = [{ subject: 'owner', since: 500 }];
        state.sessionReads = [{ subject: 'owner', ...ref('C'), readAt: 7 }];
        state.outbox = [{ subject: 'owner', id: '00000000-0000-4000-8000-000000000001', ...ref('C'), text: 'Run the suite.', createdAt: 1_000, status: 'waiting' }];
      });
      await commitAndReopen(await open(), next, 'the account records');
    },
  },
  {
    name: 'keeps text with multibyte characters and lone surrogates',
    async run(open) {
      const next = changed(state => { state.extraRelay = { data: '\ud800😀é\u0000'.repeat(10) }; });
      await commitAndReopen(await open(), next, 'the text');
    },
  },
  {
    name: 'keeps a record larger than one storage chunk',
    async run(open) {
      const next = changed(state => { state.tenants[0].broker.associations.freezes[0].extraEvidence = '😀\ud800'.repeat(80_000); });
      await commitAndReopen(await open(), next, 'the large record');
    },
  },
  {
    name: 'keeps many small records',
    async run(open) {
      const next = changed(state => {
        state.tenants[0].broker.bindings = Array.from({ length: 200 }, (_, index) => ({ agentId: `agent-${index}`, hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: `native-${index}` }));
        state.tenants[0].broker.creations = [];
        state.tenants[0].broker.associations = undefined;
        state.tenants[0].favoritesSuccession = undefined;
      });
      await commitAndReopen(await open(), next, 'the bindings');
    },
  },
  {
    name: 'leaves the stored state as it was when a commit fails, and reports the failure',
    async run(open) {
      const subject = await open();
      const first = buildCompleteRelayState(auth);
      await subject.store.commit(first);
      await subject.breakStorage();
      await expectRejects(() => subject.store.commit(changed(state => { state.sessionStars[0].title = 'Must not be stored'; state.favoritesTrees[0].folders[0].title = 'Must not be stored'; })), 'a commit over broken storage');
      await subject.repairStorage();
      expectEqual(initialOf(await subject.reopen()), first, 'the stored state');
    },
  },
];
