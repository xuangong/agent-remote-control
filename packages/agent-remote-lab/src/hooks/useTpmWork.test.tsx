import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TpmWork } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { useTpmWork, type TpmService } from './useTpmWork.js';
import type { SessionEntry } from '../session-tree.js';
import type { TpmHost } from './useTpmWork.js';
import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

it('selects a TPM once when pointer and focus arrive before the next render', async () => {
  const key = '["one","work"]';
  const { agentId: _, ...binding } = main;
  let document: WorkspaceWindow = { schemaVersion: 2, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary'), { ...createWindowView('tpm', { ...binding, nativeSessionId: 'tpm', title: 'Deliver search' }),
      feature: { kind: 'tpm', id: key, metadata: { hostId: 'one' } } }] };
  const selections: string[] = [];
  const service: TpmService = { tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [work()] }),
    tpmWork: async () => work(), tpmCreate: async () => work(), tpmAction: async () => work() };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() {
    const [, refresh] = useState(0);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }), true, 'tpm-focus', {
      window: document, readWindow: () => document,
      operate(operation) { document = applyWindowOperation(document, operation); selections.push(document.selectedViewId); refresh(value => value + 1); },
    });
    return null;
  }
  await render(<Harness />);
  await act(async () => { state.focus(key); state.focus(key); });
  expect(document.selectedViewId).toBe('tpm');
  expect(selections).toEqual(['tpm']);
});

it('creates a TPM for the presented source while a hidden Ask remains the shared selection', async () => {
  const { agentId: _, ...binding } = main;
  let document: WorkspaceWindow = { schemaVersion: 2, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'front', selectedViewId: 'ask',
    views: [createWindowView('front', binding, 'primary'), createWindowView('duplicate', binding),
      { ...createWindowView('ask', { ...binding, nativeSessionId: 'ask' }, 'float'), feature: { kind: 'ask', id: 'ask' }, closeWith: 'front' }] };
  let finish!: (value: TpmWork) => void, state!: ReturnType<typeof useTpmWork>, selectPresented!: (id: string) => void;
  const requests: unknown[] = [];
  const service: TpmService = { tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [] }),
    tpmWork: async () => work(), tpmCreate: (hostId, input) => { requests.push({ hostId, ...input }); return new Promise(resolve => { finish = resolve; }); }, tpmAction: async () => work() };
  function Harness() {
    const [presentedViewId, setPresented] = useState('front'); selectPresented = setPresented;
    const [, refresh] = useState(0);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }), true, 'presented-source', {
      window: document, readWindow: () => document,
      operate(operation) { document = applyWindowOperation(document, operation); refresh(value => value + 1); },
    }, { windowId: document.id, viewId: presentedViewId });
    return null;
  }
  await render(<Harness />);
  expect(state.canCreate(main)).toBe(true);
  expect(state.canCreate({ ...main, nativeSessionId: 'ask' })).toBe(false);
  let pending!: Promise<TpmWork>;
  await act(async () => { pending = state.create(main); });
  await act(async () => selectPresented('duplicate'));
  await act(async () => { finish(work()); await pending; });
  expect(requests).toEqual([{ hostId: 'one', providerId: 'codex', mainNativeSessionId: 'main', operationId: expect.any(String) }]);
  expect(document.views.find(view => view.feature?.kind === 'tpm')?.closeWith).toBe('front');
  expect(document.views.find(view => view.id === 'ask')?.binding?.nativeSessionId).toBe('ask');
});

it.each(['missing', 'another-window'])('rejects an unavailable presented source (%s) instead of creating for the shared selection', async invalid => {
  const { agentId: _, ...binding } = main;
  const document: WorkspaceWindow = { schemaVersion: 2, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary')] };
  const requests: unknown[] = [];
  const service: TpmService = { tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [] }),
    tpmWork: async () => work(), tpmCreate: async input => { requests.push(input); return work(); }, tpmAction: async () => work() };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() {
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }), true, 'missing-source', {
      window: document, readWindow: () => document, operate() {},
    }, { windowId: invalid === 'another-window' ? invalid : document.id, viewId: invalid === 'missing' ? invalid : 'main' });
    return null;
  }
  await render(<Harness />);
  expect(state.canCreate(main)).toBe(false);
  await expect(state.create(main)).rejects.toThrow('unavailable');
  expect(requests).toEqual([]);
});

it('keeps the selected source view when a TPM creation finishes after switching between duplicate main views', async () => {
  const binding = { hostId: main.hostId, providerId: main.providerId, nativeSessionId: main.nativeSessionId, title: main.title };
  let document: WorkspaceWindow = { schemaVersion: 2, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'b', selectedViewId: 'b',
    views: [createWindowView('a', binding, 'primary'), createWindowView('b', binding, 'primary')] };
  let finish!: (value: TpmWork) => void;
  const service: TpmService = { tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [] }),
    tpmWork: async () => work(), tpmCreate: () => new Promise(resolve => { finish = resolve; }), tpmAction: async () => work() };
  let state!: ReturnType<typeof useTpmWork>, refresh!: () => void;
  function Harness() {
    const [, update] = useState(0); refresh = () => update(value => value + 1);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }), true, 'source-test', {
      window: document, operate(operation) { document = applyWindowOperation(document, operation); refresh(); },
    });
    return null;
  }
  await render(<Harness />);
  let pending!: Promise<TpmWork>;
  await act(async () => { pending = state.create(main); });
  await act(async () => { document = applyWindowOperation(document, { type: 'view.select', viewId: 'a' }); refresh(); });
  await act(async () => { finish(work()); await pending; });
  expect(document.views.find(view => view.feature?.kind === 'tpm')?.closeWith).toBe('b');
  expect(document.selectedPrimaryViewId).toBe('a');
});

it.each(['dock', 'attached', 'float'] as const)('creates TPM work from the selected %s binding and keeps that source after selection changes', async placement => {
  const binding = { hostId: main.hostId, providerId: main.providerId, nativeSessionId: main.nativeSessionId, title: main.title };
  const primary = { ...binding, nativeSessionId: 'primary-session', title: 'Primary' };
  const source = { ...createWindowView('source', binding, placement), ...(placement === 'attached' ? { attachedTo: 'primary' } : {}) };
  let document: WorkspaceWindow = { schemaVersion: 2, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'primary', selectedViewId: source.id,
    views: [createWindowView('primary', primary, 'primary'), source, createWindowView('duplicate', binding)] };
  let finish!: (value: TpmWork) => void, refresh!: () => void, state!: ReturnType<typeof useTpmWork>;
  const requests: unknown[] = [];
  const service: TpmService = { tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [] }),
    tpmWork: async () => work(), tpmCreate: (hostId, input) => { requests.push({ hostId, ...input }); return new Promise(resolve => { finish = resolve; }); }, tpmAction: async () => work() };
  function Harness() {
    const [, update] = useState(0); refresh = () => update(value => value + 1);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }), true, 'ordinary-source', {
      window: document, operate(operation) { document = applyWindowOperation(document, operation); refresh(); },
    }); return null;
  }
  await render(<Harness />);
  expect(state.canCreate(main)).toBe(true);
  expect(state.canCreate(primary)).toBe(false);
  let pending!: Promise<TpmWork>;
  await act(async () => { pending = state.create(main); });
  await act(async () => { document = applyWindowOperation(document, { type: 'view.select', viewId: 'duplicate' }); refresh(); });
  await act(async () => { finish(work()); await pending; });
  expect(requests).toEqual([{ hostId: 'one', providerId: 'codex', mainNativeSessionId: 'main', operationId: expect.any(String) }]);
  expect(document.views.find(view => view.feature?.kind === 'tpm')?.closeWith).toBe('source');
  expect(document.selectedPrimaryViewId).toBe('primary');
  expect(document.views.find(view => view.id === 'primary')?.binding).toEqual(primary);
  expect(document.views.find(view => view.id === 'source')?.binding).toEqual(binding);
  expect(document.views.find(view => view.id === 'duplicate')?.binding).toEqual(binding);
});

it.each(['dock', 'attached', 'float'] as const)('opens an existing TPM beside its selected %s source', async placement => {
  const binding = { hostId: main.hostId, providerId: main.providerId, nativeSessionId: main.nativeSessionId, title: main.title };
  const source = { ...createWindowView('source', binding, placement), ...(placement === 'attached' ? { attachedTo: 'primary' } : {}) };
  let document: WorkspaceWindow = { schemaVersion: 2, id: 'window', revision: 0, title: 'Window', selectedPrimaryViewId: 'primary', selectedViewId: source.id,
    views: [createWindowView('primary', { ...binding, nativeSessionId: 'other' }, 'primary'), source] };
  let refresh!: () => void, state!: ReturnType<typeof useTpmWork>;
  const service: TpmService = { tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [work()] }),
    tpmWork: async () => work(), tpmCreate: async () => work(), tpmAction: async () => work() };
  function Harness() {
    const [, update] = useState(0); refresh = () => update(value => value + 1);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }), true, 'existing-source', {
      window: document, operate(operation) { document = applyWindowOperation(document, operation); refresh(); },
    }); return null;
  }
  await render(<Harness />);
  await act(async () => state.open(state.works[0]!.key));
  expect(document.views.find(view => view.feature?.kind === 'tpm')?.closeWith).toBe('source');
  expect(document.selectedPrimaryViewId).toBe('primary');
});

afterEach(() => { sessionStorage.clear(); });
const main = { hostId: 'one', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
function work(id = 'work'): TpmWork {
  return { id, revision: 1, title: 'Deliver search', providerId: 'codex', mainNativeSessionId: 'main', tpmNativeSessionId: 'tpm', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: 'Clarify scope', document: '# Search', acceptance: '', evidence: [], createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', nextCheckAt: 100 };
}
it('retains catalogs and attachment while presentation is hidden; only explicit actions change work state', async () => {
  const records = { one: [work()], two: [work()] };
  const actions: unknown[] = [];
  let attachments = 0;
  const service: TpmService = {
    tpmWork: async () => work(), tpmList: async host => ({ supported: true, supportedProviders: ['codex'], works: records[host as keyof typeof records] }),
    tpmCreate: async () => { throw new Error('No creation expected.'); },
    tpmAction: async (host, id, input) => {
      actions.push({ host, id, ...input });
      const record = records[host as keyof typeof records][0]!;
      return records[host as keyof typeof records][0] = { ...record, revision: record.revision + 1, paused: input.action === 'pause' };
    },
  };
  let state!: ReturnType<typeof useTpmWork>;
  let hide!: () => void;
  function Harness() {
    const [visible, setVisible] = useState(true);
    hide = () => setVisible(value => !value);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }, { id: 'two', name: 'Two', online: true }], true,
      async value => { attachments++; return { ...main, ...value, agentId: 'tpm-agent' }; });
    return <div hidden={!visible}>{state.works.map(value => <span key={value.key}>{value.hostName}: {value.work.title}</span>)}</div>;
  }
  const container = await render(<Harness />);
  expect(state.works).toHaveLength(2);
  expect(state.works[0]!.key).not.toBe(state.works[1]!.key);
  const first = state.works[0]!;
  await act(async () => state.open(first.key));
  await act(async () => { hide(); state.close(); });
  expect(container.firstElementChild?.hasAttribute('hidden')).toBe(true);
  expect(state.sessions[first.key]?.agentId).toBe('tpm-agent');
  expect(actions).toEqual([]);
  await act(async () => { hide(); state.open(first.key); });
  expect(attachments).toBe(1);
  await act(async () => state.action(first.key, 'pause'));
  expect(state.works.find(value => value.key === first.key)!.work.paused).toBe(true);
  expect(actions).toMatchObject([{ host: 'one', id: 'work', revision: 1, action: 'pause' }]);
  await act(async () => state.action(first.key, 'resume'));
  expect(state.works.find(value => value.key === first.key)!.work.paused).toBe(false);
});
it('does not replace a newer mutation result with an older in-flight catalog response', async () => {
  let record = work();
  let finish!: (catalog: { supported: boolean; works: TpmWork[]; supportedProviders: string[] }) => void;
  let delay = false;
  const service: TpmService = {
    tpmWork: async () => work(), tpmList: async () => delay ? new Promise(resolve => { finish = resolve; }) : ({ supported: true, supportedProviders: ['codex'], works: [record] }),
    tpmCreate: async () => record,
    tpmAction: async () => record = { ...record, revision: 2, paused: true },
  };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'agent' })); return null; }
  await render(<Harness />);
  const stale = record;
  delay = true;
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); });
  await act(async () => state.action(state.works[0]!.key, 'pause'));
  await act(async () => { finish({ supported: true, supportedProviders: ['codex'], works: [stale] }); await pending; });
  expect(state.works[0]!.work.revision).toBe(2);
  expect(state.works[0]!.work.paused).toBe(true);
});
it('preserves unread delivery changes while the workspace view is disabled and restores the same selected work', async () => {
  let record = work();
  const service: TpmService = { tpmWork: async () => work(), tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [record] }), tpmCreate: async () => record, tpmAction: async () => record };
  let state!: ReturnType<typeof useTpmWork>;
  let show!: (value: boolean) => void;
  function Harness() {
    const [visible, setVisible] = useState(true); show = setVisible;
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'agent' }), visible);
    return null;
  }
  await render(<Harness />);
  await act(async () => state.open(state.works[0]!.key));
  const selected = state.selected;
  await act(async () => show(false));
  record = { ...record, revision: 2, summary: 'Acceptance needs review' };
  await act(async () => state.refresh());
  expect(state.works[0]!.unread).toBe(true);
  expect(state.expanded).toBe(true);
  expect(state.selected).toBe(selected);
  await act(async () => show(true));
  expect(state.works[0]!.unread).toBe(false);
});
it('binds creation to the main native identity and ignores silent heartbeat changes for unread activity', async () => {
  let record = work();
  const creates: unknown[] = [];
  const service: TpmService = {
    tpmWork: async () => work(), tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [record] }),
    tpmCreate: async (host, input) => { creates.push({ host, ...input }); return record; },
    tpmAction: async () => record,
  };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' })); return null; }
  await render(<Harness />);
  await act(async () => state.create(main, ' Search ', ' Find items '));
  expect(creates).toMatchObject([{ host: 'one', providerId: 'codex', mainNativeSessionId: 'main', title: 'Search', requirement: 'Find items' }]);
  expect((creates[0] as { operationId: string }).operationId).toBeTruthy();
  await act(async () => state.close());
  record = { ...record, revision: 2, updatedAt: '2026-10-09T01:00:00Z', nextCheckAt: 200 };
  await act(async () => state.refresh());
  expect(state.works[0]!.unread).toBe(false);
  record = { ...record, revision: 3, waiting: 'user', summary: 'Choose the search scope.' };
  await act(async () => state.refresh());
  expect(state.works[0]!.unread).toBe(true);
  await act(async () => state.open(state.works[0]!.key));
  expect(state.works[0]!.unread).toBe(false);
});
it('does not create work for an unadvertised provider or an older Controller', async () => {
  let creates = 0;
  const service: TpmService = { tpmWork: async () => work(), tpmList: async () => ({ supported: true, supportedProviders: ['claude'], works: [] }),
    tpmCreate: async () => { creates++; return work(); }, tpmAction: async () => work() };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'agent' })); return null; }
  await render(<Harness />);
  expect(state.canCreate(main)).toBe(false);
  await expect(state.create(main, 'Title', 'Need')).rejects.toThrow('unavailable');
  expect(creates).toBe(0);
});
it('removes stale catalog access when the Host becomes shared and refuses further actions', async () => {
  let actions = 0;
  const service: TpmService = { tpmWork: async () => work(), tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [work()] }), tpmCreate: async () => work(), tpmAction: async () => { actions++; return work(); } };
  let state!: ReturnType<typeof useTpmWork>;
  let revoke!: () => void;
  function Harness() {
    const [hosts, setHosts] = useState<TpmHost[]>([{ id: 'one', name: 'One', online: true, access: 'owner' }]);
    revoke = () => setHosts([{ id: 'one', name: 'One', online: true, access: 'shared' }]);
    state = useTpmWork(service, hosts, true, async value => ({ ...value, agentId: 'agent' }));
    return null;
  }
  await render(<Harness />);
  const key = state.works[0]!.key;
  await act(async () => state.open(key));
  await act(async () => revoke());
  expect(state.works).toEqual([]);
  await expect(state.action(key, 'pause')).rejects.toThrow('unavailable');
  expect(actions).toBe(0);
});
it('does not expose the previous workspace catalog after its service is replaced', async () => {
  const first: TpmService = { tpmWork: async () => work(), tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [work()] }), tpmCreate: async () => work(), tpmAction: async () => work() };
  const second: TpmService = { ...first, tpmWork: async () => work(), tpmList: async () => ({ supported: false, works: [] }) };
  let state!: ReturnType<typeof useTpmWork>;
  let switchWorkspace!: () => void;
  function Harness() {
    const [service, setService] = useState(first); switchWorkspace = () => setService(second);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'agent' }));
    return null;
  }
  await render(<Harness />);
  await act(async () => state.open(state.works[0]!.key));
  await act(async () => switchWorkspace());
  expect(state.works).toEqual([]);
  expect(state.sessions).toEqual({});
  expect(state.opened).toEqual([]);
});
it('clears cached works and attachment access when the catalog authorization is denied', async () => {
  let denied = false, actions = 0;
  const service: TpmService = { tpmWork: async () => work(), tpmList: async () => {
    if (denied) throw Object.assign(new Error('Host owner access required.'), { status: 403 });
    return { supported: true, supportedProviders: ['codex'], works: [work()] };
  }, tpmCreate: async () => work(), tpmAction: async () => { actions++; return work(); } };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'agent' })); return null; }
  await render(<Harness />);
  const key = state.works[0]!.key;
  await act(async () => state.open(key));
  denied = true;
  await act(async () => state.refresh());
  expect(state.works).toEqual([]);
  expect(state.sessions).toEqual({});
  await expect(state.action(key, 'pause')).rejects.toThrow('unavailable');
  expect(actions).toBe(0);
});
it('keeps the new workspace attachment pending when an old request for the same work completes', async () => {
  const first: TpmService = { tpmWork: async () => work(), tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [work()] }), tpmCreate: async () => work(), tpmAction: async () => work() };
  const second: TpmService = { ...first };
  let state!: ReturnType<typeof useTpmWork>;
  let switchWorkspace!: () => void;
  const finish: (() => void)[] = [];
  let attachments = 0;
  function Harness() {
    const [service, setService] = useState(first); switchWorkspace = () => setService(second);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, value => new Promise(resolve => {
      attachments++;
      finish.push(() => resolve({ ...value, agentId: `agent-${attachments}` }));
    }));
    return null;
  }
  await render(<Harness />);
  const key = state.works[0]!.key;
  let oldRequest!: Promise<void>, newRequest!: Promise<void>;
  await act(async () => { oldRequest = state.open(key); });
  await act(async () => switchWorkspace());
  await act(async () => { newRequest = state.open(key); });
  expect(attachments).toBe(2);
  await act(async () => { finish[0]!(); await oldRequest; });
  expect(state.attaching[key]).toBe(true);
  await act(async () => { void state.open(key); });
  expect(attachments).toBe(2);
  await act(async () => { finish[1]!(); await newRequest; });
  expect(state.attaching[key]).toBe(false);
  expect(state.sessions[key]?.agentId).toBe('agent-2');
});
it('does not restore an in-flight attached session after catalog access is denied', async () => {
  let denied = false;
  const service: TpmService = { tpmWork: async () => work(), tpmList: async () => {
    if (denied) throw Object.assign(new Error('Host owner access required.'), { status: 403 });
    return { supported: true, supportedProviders: ['codex'], works: [work()] };
  }, tpmCreate: async () => work(), tpmAction: async () => work() };
  let state!: ReturnType<typeof useTpmWork>;
  let finish!: () => void;
  function Harness() {
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, value => new Promise(resolve => {
      finish = () => resolve({ ...value, agentId: 'agent' });
    }));
    return null;
  }
  await render(<Harness />);
  let request!: Promise<void>;
  await act(async () => { request = state.open(state.works[0]!.key); });
  denied = true;
  await act(async () => state.refresh());
  await act(async () => { finish(); await request; });
  expect(state.sessions).toEqual({});
});
it('reuses the creation intent after a lost response and starts a new intent after acceptance', async () => {
  const operationIds: string[] = [];
  const service: TpmService = {
    tpmWork: async () => work(), tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [] }),
    tpmCreate: async (_, input) => {
      operationIds.push(input.operationId);
      if (operationIds.length === 1) throw new Error('Creation response was lost.');
      return work();
    },
    tpmAction: async () => work(),
  };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'agent' })); return null; }
  await render(<Harness />);
  await act(async () => { await expect(state.create(main, 'Search', 'Find items')).rejects.toThrow('lost'); });
  await act(async () => state.create(main, ' Search ', ' Find items '));
  expect(operationIds[1]).toBe(operationIds[0]);
  await act(async () => state.create(main, 'Search', 'Find items'));
  expect(operationIds[2]).not.toBe(operationIds[0]);
});
it('loads full work on opening and never presents older document content as a newer revision', async () => {
  let record = { ...work(), document: '# First plan' };
  let finish!: (value: TpmWork) => void;
  let reads = 0;
  const summary = () => ({ ...record, document: '', acceptance: '', evidence: [], detailsOmitted: true } as TpmWork);
  const service: TpmService = {
    tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [summary()] }),
    tpmWork: async () => { reads++; return reads === 1 ? record : new Promise(resolve => { finish = resolve; }); },
    tpmCreate: async () => record, tpmAction: async () => record,
  };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => ({ ...value, agentId: 'agent' })); return null; }
  await render(<Harness />);
  expect(reads).toBe(0);
  const key = state.works[0]!.key;
  await act(async () => state.open(key));
  expect(reads).toBe(1);
  expect(state.works[0]!.work.document).toBe('# First plan');
  record = { ...record, revision: 2, document: '# Revised plan' };
  await act(async () => { state.close(); await state.refresh(); });
  expect(reads).toBe(2);
  expect(state.works[0]!.work.revision).toBe(2);
  expect(state.works[0]!.work.document).toBe('');
  await act(async () => { finish(record); });
  expect(state.works[0]!.work.document).toBe('# Revised plan');
  expect(state.sessions[key]?.agentId).toBe('agent');
});
it('discards details from a replaced workspace without clearing the replacement loading state', async () => {
  const finish: ((value: TpmWork) => void)[] = [];
  const summary = { ...work(), document: '', detailsOmitted: true as const };
  const first: TpmService = {
    tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [summary] }),
    tpmWork: async () => new Promise(resolve => finish.push(resolve)), tpmCreate: async () => work(), tpmAction: async () => work(),
  };
  const second: TpmService = { ...first };
  let state!: ReturnType<typeof useTpmWork>;
  let switchWorkspace!: () => void;
  let attachments = 0;
  function Harness() {
    const [service, setService] = useState(first); switchWorkspace = () => setService(second);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => { attachments++; return { ...value, agentId: 'agent' }; });
    return null;
  }
  await render(<Harness />);
  const key = state.works[0]!.key;
  let oldRequest!: Promise<void>, newRequest!: Promise<void>;
  await act(async () => { oldRequest = state.open(key); });
  await act(async () => switchWorkspace());
  await act(async () => { newRequest = state.open(key); });
  await act(async () => { finish[0]!({ ...work(), document: '# Old workspace' }); await oldRequest; });
  expect(state.works[0]!.work.document).toBe('');
  expect(state.detailsLoading[key]).toBe(true);
  expect(attachments).toBe(0);
  await act(async () => { finish[1]!({ ...work(), document: '# New workspace' }); await newRequest; });
  expect(state.works[0]!.work.document).toBe('# New workspace');
  expect(attachments).toBe(1);
});
it('removes cached access when opening full work details is rejected by the Host', async () => {
  const service: TpmService = {
    tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [{ ...work(), detailsOmitted: true }] }),
    tpmWork: async () => { throw Object.assign(new Error('Host owner access required.'), { status: 403 }); },
    tpmCreate: async () => work(), tpmAction: async () => work(),
  };
  let state!: ReturnType<typeof useTpmWork>;
  let attachments = 0;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, async value => { attachments++; return { ...value, agentId: 'agent' }; }); return null; }
  await render(<Harness />);
  await act(async () => state.open(state.works[0]!.key));
  expect(state.works).toEqual([]);
  expect(state.sessions).toEqual({});
  expect(attachments).toBe(0);
});

it('keeps multiple TPM windows open, focuses without reattaching, and minimizes each independently', async () => {
  const records = [work(), { ...work(), id: 'second', tpmNativeSessionId: 'tpm-second' }];
  const attach = vi.fn(async (value: SessionEntry) => ({ ...value, agentId: value.nativeSessionId }));
  const service: TpmService = { tpmList: async () => ({ supported: true, works: records }),
    tpmWork: async (_host, id) => records.find(item => item.id === id)!, tpmCreate: async () => records[0]!, tpmAction: async () => records[0]! };
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, attach); return null; }
  await render(<Harness />);
  const [first, second] = state.works.map(item => item.key);
  await act(async () => state.open(first!));
  await act(async () => state.open(second!));
  expect(state.windows).toEqual([first, second]);
  expect(state.selected).toBe(second);
  await act(async () => state.focus(first!));
  expect(state.windows).toEqual([second, first]);
  expect(state.selected).toBe(first);
  expect(attach).toHaveBeenCalledTimes(2);
  await act(async () => state.close(first));
  expect(state.windows).toEqual([second]);
  expect(state.selected).toBe(second);
  expect(state.sessions[first!]).toBeDefined();
  await act(async () => state.open(first!));
  expect(attach).toHaveBeenCalledTimes(2);
  await act(async () => state.close());
  expect(state.windows).toEqual([]);
  expect(state.expanded).toBe(false);
});

it('restores all open TPM windows after a reload without changing their focus order', async () => {
  const records = [work('first'), work('second')];
  const service: TpmService = { tpmList: async () => ({ supported: true, works: records }), tpmWork: async (_host, id) => records.find(item => item.id === id)!, tpmCreate: vi.fn(), tpmAction: vi.fn() };
  const attach = vi.fn(async (session: SessionEntry) => ({ ...session, agentId: session.nativeSessionId }));
  let state!: ReturnType<typeof useTpmWork>, reload!: () => void;
  function Workspace() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, attach, true, 'reload'); return null; }
  function Harness() { const [revision, setRevision] = useState(0); reload = () => setRevision(v => v + 1); return <Workspace key={revision} />; }
  await render(<Harness />);
  await act(async () => { await state.open('["one","first"]'); await state.open('["one","second"]'); });
  expect(state.windows).toHaveLength(2);
  await act(async () => reload());
  expect(state.windows).toEqual(['["one","first"]', '["one","second"]']);
  expect(state.sessions['["one","first"]']).toBeDefined();
  expect(state.sessions['["one","second"]']).toBeDefined();
});

it('replaces a held TPM connection from the authoritative locator without changing the logical window', async () => {
  let record = work();
  const service: TpmService = { tpmWork: async () => record, tpmList: async () => ({ supported: true, works: [record] }), tpmCreate: async () => record, tpmAction: async () => record };
  const attach = vi.fn(async (value: SessionEntry) => ({ ...value, agentId: value.nativeSessionId }));
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, attach); return null; }
  await render(<Harness />);
  const key = state.works[0]!.key;
  await act(async () => state.open(key));
  expect(state.sessions[key]?.nativeSessionId).toBe('tpm');
  record = { ...record, revision: 2, tpmNativeSessionId: 'successor' };
  await act(async () => state.refresh());
  expect(state.sessions[key]?.nativeSessionId).toBe('successor');
  expect(state.windows).toEqual([key]);
  expect(attach.mock.calls.map(([value]) => value.nativeSessionId)).toEqual(['tpm', 'successor']);
  record = { ...record, revision: 3, tpmNativeSessionId: undefined };
  await act(async () => state.refresh());
  expect(state.sessions[key]).toBeUndefined();
  expect(state.windows).toEqual([key]);
  expect(attach).toHaveBeenCalledTimes(2);
});

it('ignores a delayed old native attachment after the same TPM work follows its current locator', async () => {
  let record = work(), release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service: TpmService = { tpmWork: async () => record, tpmList: async () => ({ supported: true, works: [record] }), tpmCreate: async () => record, tpmAction: async () => record };
  const attach = vi.fn(async (value: SessionEntry) => { if (value.nativeSessionId === 'tpm') await gate; return { ...value, agentId: value.nativeSessionId }; });
  let state!: ReturnType<typeof useTpmWork>;
  function Harness() { state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, attach); return null; }
  await render(<Harness />);
  const key = state.works[0]!.key;
  let pending!: Promise<void>;
  await act(async () => { pending = state.open(key); });
  record = { ...record, revision: 2, tpmNativeSessionId: 'successor' };
  await act(async () => state.refresh());
  expect(state.sessions[key]?.nativeSessionId).toBe('successor');
  await act(async () => { release(); await pending; });
  expect(state.sessions[key]?.nativeSessionId).toBe('successor');
  expect(state.windows).toEqual([key]);
  expect(attach.mock.calls.map(([value]) => value.nativeSessionId)).toEqual(['tpm', 'successor']);
});

it.each((['primary', 'dock', 'attached', 'float'] as const).flatMap(placement =>
  (['rebound', 'closed', 'another-window'] as const).map(change => ({ placement, change }))))('retains the created TPM catalog without opening a late result after its $placement source is $change', async ({ placement, change }) => {
  const binding = { hostId: main.hostId, providerId: main.providerId, nativeSessionId: main.nativeSessionId, title: main.title };
  const source = { ...createWindowView('b', binding, placement), ...(placement === 'attached' ? { attachedTo: 'a' } : {}) };
  let document: WorkspaceWindow = { schemaVersion: 2, id: 'origin', revision: 0, title: 'Window', selectedPrimaryViewId: placement === 'primary' ? 'b' : 'a', selectedViewId: 'b',
    views: [createWindowView('a', binding, 'primary'), source] };
  let finish!: (value: TpmWork) => void, refresh!: () => void, state!: ReturnType<typeof useTpmWork>;
  const attach = vi.fn(async (value: SessionEntry) => ({ ...value, agentId: 'tpm-agent' }));
  const service: TpmService = { tpmList: async () => ({ supported: true, supportedProviders: ['codex'], works: [] }),
    tpmWork: async () => work(), tpmCreate: () => new Promise(resolve => { finish = resolve; }), tpmAction: async () => work() };
  function Harness() {
    const [, update] = useState(0); refresh = () => update(value => value + 1);
    state = useTpmWork(service, [{ id: 'one', name: 'One', online: true }], true, attach, true, 'source-change', {
      window: document, operate(operation) { document = applyWindowOperation(document, operation); refresh(); },
    }); return null;
  }
  await render(<Harness />);
  let pending!: Promise<TpmWork>;
  await act(async () => { pending = state.create(main); });
  await act(async () => {
    document = change === 'another-window' ? { ...document, id: 'destination' }
      : applyWindowOperation(document, change === 'closed' ? { type: 'view.close', viewId: 'b' }
        : { type: 'view.bind', viewId: 'b', binding: { ...binding, nativeSessionId: 'replacement' } });
    refresh();
  });
  await act(async () => { finish(work()); await pending; });
  expect(state.works.map(item => item.work.id)).toContain('work');
  expect(document.views.some(view => view.feature?.kind === 'tpm')).toBe(false);
  expect(attach).not.toHaveBeenCalled();
});
