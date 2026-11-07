import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionReferences } from './SessionReferences.js';

afterEach(() => { vi.unstubAllGlobals(); });

function host(refs: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ revision: 1, refs }), { status: 200, headers: { 'content-type': 'application/json' } })));
}
async function shown(holder: string, snapshot?: string) {
  const container = await render(<SessionReferences scope="https://relay.example/u/test/" holder={{ hostId: 'host', providerId: 'claude', nativeSessionId: holder }}
    providers={['claude']} fallback={<p>Fallback</p>} snapshot={snapshot ? <p>{snapshot}</p> : undefined} picking={false} onPickingChange={() => {}} onOpen={() => {}} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return container;
}

it('shows a Side\'s source from its Host, and a fork\'s copied context beside the references', async () => {
  host([{ providerId: 'claude', nativeSessionId: 'source', title: 'Source', origin: 'source' }]);
  const side = await shown('side');
  expect(side.querySelector('[aria-label="Session references"]')?.textContent).toContain('Source');
  expect(side.textContent).not.toContain('Fallback');

  host([]);
  const fork = await shown('fork', 'Snapshot context');
  expect(fork.textContent).toBe('Snapshot context');

  host([{ providerId: 'claude', nativeSessionId: 'other', title: 'Other', origin: 'added' }]);
  const both = await shown('fork-with-ref', 'Snapshot context');
  expect(both.textContent).toContain('Snapshot context');
  expect(both.querySelector('[aria-label="Session references"]')?.textContent).toContain('Other');
});

it('gives up a pending choice when anything outside the picker is touched, but not the add button', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(JSON.stringify(String(url).includes('/catalog') ? { items: [], hasMore: false, revision: '1' }
    : { revision: 1, refs: [{ providerId: 'claude', nativeSessionId: 'source', title: 'Source', origin: 'source' }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const picking = vi.fn();
  const container = await render(<><button type="button">Outside</button><SessionReferences scope="https://relay.example/u/test/" holder={{ hostId: 'host', providerId: 'claude', nativeSessionId: 'side' }}
    providers={['claude']} picking onPickingChange={picking} onOpen={() => {}} /></>);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const touch = (element: Element) => act(async () => { element.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  await touch(container.querySelector('.lab-session-ref-picker input')!);
  await touch(container.querySelector('.lab-session-ref-add')!);
  expect(picking).not.toHaveBeenCalled();
  await touch(container.querySelector('button')!);
  expect(picking).toHaveBeenCalledWith(false);
});
