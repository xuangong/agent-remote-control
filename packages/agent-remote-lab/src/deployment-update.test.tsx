import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastProvider } from './components/Toast.js';
import { deploymentEntry, runningDeploymentEntry, watchDeploymentUpdate } from './deployment-update.js';
import { useDeploymentUpdate } from './hooks/useDeploymentUpdate.js';

const index = (entry: string) => `<!doctype html><html><head><meta charset="UTF-8" />
  <script type="module" crossorigin src="${entry}"></script><link rel="stylesheet" href="/assets/index-a.css"></head><body></body></html>`;
const roots: Array<{ root: Root; element: HTMLElement }> = [];
let visibility: ReturnType<typeof vi.spyOn> | undefined;
afterEach(async () => {
  for (const { root, element } of roots.splice(0)) { await act(async () => root.unmount()); element.remove(); }
  document.head.querySelectorAll('script[data-test-entry]').forEach(script => script.remove());
  visibility?.mockRestore(); visibility = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function setVisibility(state: DocumentVisibilityState) {
  visibility ??= vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

it('reads only a built module entry from an index document', () => {
  expect(deploymentEntry(index('/assets/index-B.js'))).toBe('/assets/index-B.js');
  expect(deploymentEntry('<script type="module" src="/src/main.tsx"></script>')).toBeUndefined();
  expect(deploymentEntry('<script src="/assets/legacy.js"></script>')).toBeUndefined();
  const script = document.createElement('script'); script.type = 'module'; script.setAttribute('src', '/assets/index-A.js'); script.dataset.testEntry = '';
  document.head.append(script);
  expect(runningDeploymentEntry(document)).toBe('/assets/index-A.js');
});

it('reports a different deployed entry once, on resume or on its interval, and ignores failed checks', async () => {
  vi.useFakeTimers();
  setVisibility('visible');
  let deployed = '/assets/index-A.js', failing = false;
  const fetchIndex = vi.fn(async () => { if (failing) throw new Error('offline'); return index(deployed); });
  const onUpdate = vi.fn();
  const stop = watchDeploymentUpdate({ running: '/assets/index-A.js', onUpdate, fetchIndex, intervalMs: 60_000 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchIndex).toHaveBeenCalledTimes(1); expect(onUpdate).not.toHaveBeenCalled();
  failing = true; deployed = '/assets/index-B.js';
  setVisibility('hidden'); setVisibility('visible'); await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).not.toHaveBeenCalled();
  failing = false;
  setVisibility('hidden'); setVisibility('visible'); await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  stop();
  expect(watchDeploymentUpdate({ running: undefined, onUpdate, fetchIndex })).toBeTypeOf('function');
});

async function mount(reload: () => void) {
  const script = document.createElement('script'); script.type = 'module'; script.setAttribute('src', '/assets/index-A.js'); script.dataset.testEntry = '';
  document.head.append(script);
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element); roots.push({ root, element });
  function Harness() { useDeploymentUpdate(true, reload); return null; }
  await act(async () => root.render(<ToastProvider><Harness /></ToastProvider>));
  return element;
}

it('loads a newer deployment at once when the page is hidden', async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
  setVisibility('hidden');
  const reload = vi.fn();
  await mount(reload);
  await act(async () => { setVisibility('visible'); });
  await act(async () => { setVisibility('hidden'); respond(new Response(index('/assets/index-B.js'))); });
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(document.body.textContent).not.toContain('Update available');
});

it('offers a newer deployment in a visible page and loads it once the page is left', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(index('/assets/index-B.js'))));
  setVisibility('hidden');
  const reload = vi.fn();
  await mount(reload);
  await act(async () => { setVisibility('visible'); });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Update available'));
  expect(reload).not.toHaveBeenCalled();
  await act(async () => { setVisibility('hidden'); });
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reloads from the update notification', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(index('/assets/index-B.js'))));
  setVisibility('hidden');
  const reload = vi.fn();
  await mount(reload);
  await act(async () => { setVisibility('visible'); });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Update available'));
  const button = [...document.body.querySelectorAll('button')].find(item => item.textContent === 'Reload')!;
  await act(async () => { button.click(); });
  expect(reload).toHaveBeenCalledTimes(1);
});
