import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import type { SessionEntry } from '../session-tree.js';
import { SessionDescriptionsContext } from '../session-description-context.js';
import { LabWorkbench } from './LabWorkbench.js';
import { SessionDockProvider, SessionDockRail, SessionViewPlacement } from './SessionDock.js';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => vi.unstubAllGlobals());

it('preserves each product view disclosure across placement changes and keeps late navigation scoped to its binding', async () => {
  const initial: SessionEntry = { hostId: 'host', providerId: 'codex', nativeSessionId: 'first', title: 'First task' };
  let enable!: (enabled: boolean) => void, bind!: (session: SessionEntry) => void;
  let reject!: (error: Error) => void;
  function Harness() {
    const [enabled, setEnabled] = useState(true); enable = setEnabled;
    const [session, setSession] = useState(initial); bind = setSession;
    return <SessionDescriptionsContext.Provider value={{ describe: source => ({ identity: source, attributions: [{
      id: 'main', kind: 'main', label: 'Main', value: `Main for ${source.title}`,
      target: { kind: 'session', hostId: source.hostId, providerId: source.providerId, nativeSessionId: `main-${source.nativeSessionId}` },
    }] }), navigate: () => new Promise<void>((_resolve, fail) => { reject = fail; }) }}>
      <SessionDockProvider enabled={enabled}><SessionDockRail>Main area</SessionDockRail>
        {['one', 'two'].map(id => {
          const source = id === 'one' ? session : initial;
          return <SessionViewPlacement key={id} id={id} title={id} visible>{({ controls }) => <section data-view={id}>
            <LabWorkbench sessionIdentity={source} state={replicaState} sessionStatus="ready" actions={{}}
              sessionManager={controls} conversationPath={<strong>{source.title}</strong>} messageDraft={`Draft for ${source.title}`} />
          </section>}</SessionViewPlacement>;
        })}
      </SessionDockProvider>
    </SessionDescriptionsContext.Provider>;
  }
  const container = await render(<Harness />);
  const first = container.querySelector<HTMLElement>('[data-view="one"]')!;
  const second = container.querySelector<HTMLElement>('[data-view="two"]')!;
  const timeline = first.querySelector('[data-testid="timeline"]');
  const draft = first.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]');
  await act(async () => first.querySelector<HTMLButtonElement>('[aria-label="Show session attributions"]')!.click());
  for (const id of ['one', 'two']) await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Dock ${id}"]`)!.click());
  expect(container.querySelector('[data-dock-id="one"] table')?.textContent).toContain('Main for First task');
  expect(second.querySelector('table')).toBeNull();
  expect(first.querySelector('[data-testid="timeline"]')).toBe(timeline);
  expect(first.querySelector('[data-testid="prompt-input"]')).toBe(draft);
  await act(async () => enable(false));
  expect(container.querySelector('[data-dock-id]')).toBeNull();
  expect(first.querySelector('table')).not.toBeNull();
  expect(second.querySelector('table')).toBeNull();
  await act(async () => enable(true));
  await act(async () => first.querySelector<HTMLButtonElement>('td button')!.click());
  expect(first.querySelector('td [role="status"]')?.textContent).toBe('Opening…');
  await act(async () => bind({ ...initial, nativeSessionId: 'replacement', title: 'Replacement task' }));
  await act(async () => reject(new Error('The previous main is unavailable')));
  expect(first.querySelector('table')?.textContent).toContain('Main for Replacement task');
  expect(first.querySelector('td [role="alert"]')).toBeNull();
  expect(first.querySelector('td [role="status"]')).toBeNull();
  expect(draft?.value).toBe('Draft for Replacement task');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Float one"]')!.click());
  expect(first.querySelector('[data-testid="timeline"]')).toBe(timeline);
  expect(first.querySelector('[data-testid="prompt-input"]')).toBe(draft);
  expect(first.querySelector('table')).not.toBeNull();
  expect(second.querySelector('table')).toBeNull();
}, 10000);
