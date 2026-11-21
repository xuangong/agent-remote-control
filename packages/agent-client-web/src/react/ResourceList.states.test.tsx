// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, rerender } from '../test/setup.js';
import { ResourceList } from './ResourceList.js';

const file = { resourceId: 'proof', locator: 'artifacts/lab-proof.txt', status: 'available' as const };
const metadata = { status: 'available' as const, mediaType: 'text/plain', byteLength: 12, sha256: 'digest' };
const bytes = (text: string) => btoa(text);

it('loads an available file on request, then offers its bytes as a named download', async () => {
  const request = vi.fn(async () => {});
  const container = await render(<ResourceList bindings={[file]} resources={{ proof: metadata }} onRequest={request} />);
  expect(container.querySelector('.agent-state-label')?.textContent).toBe('Available');
  expect(request).not.toHaveBeenCalled();
  expect(container.querySelector('[data-resource-download]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[data-resource-id="proof"]')!.click());
  expect(request).toHaveBeenCalledExactlyOnceWith(file);
  await rerender(container, <ResourceList bindings={[file]} resources={{ proof: { ...metadata, contentBase64: bytes('hello world\n') } }} onRequest={request} />);
  const download = container.querySelector<HTMLAnchorElement>('a[data-resource-download="proof"]')!;
  expect(download.getAttribute('download')).toBe('lab-proof.txt');
  expect(atob(download.getAttribute('href')!.split(',')[1]!)).toBe('hello world\n');
  expect(container.querySelector('button[data-resource-id="proof"]')).toBeNull();
});

it('says a resource is unavailable with its reason and offers nothing to load or download', async () => {
  const gone = { resourceId: 'gone', locator: 'artifacts/missing.txt', status: 'unavailable' as const };
  const container = await render(<ResourceList bindings={[gone]} resources={{ gone: { status: 'unavailable', reason: 'The file was removed.' } }} onRequest={async () => {}} />);
  expect(container.querySelector('.agent-state-label')?.textContent).toBe('Unavailable');
  expect(container.textContent).toContain('The file was removed.');
  expect(container.querySelector('button')).toBeNull();
  expect(container.querySelector('a')).toBeNull();
});

it('keeps the load control after a failed request and shows why', async () => {
  const request = vi.fn(async () => { throw new Error('The Host stopped reading resources.'); });
  const container = await render(<ResourceList bindings={[file]} resources={{ proof: metadata }} onRequest={request} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button[data-resource-id="proof"]')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The Host stopped reading resources.');
  expect(container.querySelector<HTMLButtonElement>('button[data-resource-id="proof"]')?.disabled).toBe(false);
});
