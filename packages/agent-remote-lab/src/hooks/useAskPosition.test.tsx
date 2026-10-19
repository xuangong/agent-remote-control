import { act, useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { render, unmount } from '../test/setup.js';
import { conversationLocalStorage } from '../conversation-storage.js';
import { createAskOwner, createCompositionDocument, createCompositionSlot } from '../session-composition.js';
import { bindWindowCompositionSlot, resolveCompositionWindowViewId } from '../window-composition.js';
import { WindowLayoutContext } from '../window-workspace-context.js';
import { createWindowFeature } from '../window-feature-views.js';
import { windowSessionBinding } from '../window-workspace.js';
import { useAskPosition, inspectAskPosition, flushAskPosition } from './useAskPosition.js';

const observers = new Set<() => void>();
const bounds = new Map<string, { width: number; height: number }>();
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });

beforeEach(() => {
  conversationLocalStorage.clear();
  localStorage.clear();
  bounds.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
    callback: () => void;
    observe() {}
    disconnect() { observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-owner]')!;
    const size = bounds.get(owner.dataset.owner!)!;
    if (this.classList.contains('test-edge-control')) return rect(200 + size.width - 120, 180, 108, 44);
    if (this.classList.contains('lab-ask-viewport')) return rect(200, 80, size.width, size.height);
    if (this.tagName === 'SECTION') return rect(
      200 + parseFloat(this.style.getPropertyValue('--ask-left') || '0'),
      80 + parseFloat(this.style.getPropertyValue('--ask-top') || '0'),
      parseFloat(this.style.getPropertyValue('--ask-width') || '440'),
      parseFloat(this.style.getPropertyValue('--ask-height') || '560'),
    );
    return rect(owner.dataset.anchor === 'left' ? 200 : 200 + size.width - 60, 180, 60, 44);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); conversationLocalStorage.clear(); localStorage.clear(); });

function Harness({ scope, besideAnchor = false, anchorSide, edgeControls = false }: { scope: string; besideAnchor?: boolean; anchorSide?: string; edgeControls?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useAskPosition(panel, trigger, scope, { besideAnchor, edgeControls: edgeControls ? '.test-edge-control' : undefined });
  return <div data-owner={scope} data-anchor={anchorSide}><button ref={trigger}>Ask</button>{edgeControls ? <button className="test-edge-control">Windows</button> : null}<div className="lab-ask-viewport"><section ref={panel}>
    <header className="lab-ask-heading">Ask</header>
    <button className="lab-ask-resize">Resize</button>
  </section></div></div>;
}

const geometry = (element: Element) => {
  const style = (element as HTMLElement).style;
  return Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, parseFloat(style.getPropertyValue(`--ask-${key}`))]));
};
it.each(['left', 'right'])('opens beside the persistent %s launcher without covering its controls', async anchorSide => {
  bounds.set('global', { width: 1000, height: 800 });
  const container = await render(<Harness scope="global" besideAnchor anchorSide={anchorSide} />);
  const button = container.querySelector('button')!.getBoundingClientRect();
  const panel = container.querySelector('section')!.getBoundingClientRect();
  if (anchorSide === 'left') expect(panel.left).toBeGreaterThan(button.right);
  else expect(panel.right).toBeLessThan(button.left);
});
it('keeps restored and resized windows clear of the measured edge controls', async () => {
  const scope = 'global-edge-controls';
  bounds.set(scope, { width: 1000, height: 800 });
  conversationLocalStorage.setItem(`agent-remote-ask:${scope}:window-position`, JSON.stringify({ x: 900, y: 100 }));
  conversationLocalStorage.setItem(`agent-remote-ask:${scope}:window-size`, JSON.stringify({ width: 900, height: 560 }));
  const container = await render(<Harness scope={scope} besideAnchor edgeControls />);
  const panel = container.querySelector('section')!;
  const control = container.querySelector('.test-edge-control')!;
  expect(panel.getBoundingClientRect().right).toBeLessThan(control.getBoundingClientRect().left);
  await key(container.querySelector('.lab-ask-resize')!, 'ArrowRight', true);
  expect(panel.getBoundingClientRect().right).toBeLessThan(control.getBoundingClientRect().left);
  for (const width of [650, 1000]) {
    bounds.set(scope, { width, height: 800 });
    await act(async () => { for (const update of observers) update(); });
    expect(panel.getBoundingClientRect().right).toBeLessThan(control.getBoundingClientRect().left);
  }
});
async function key(element: Element, name: string, shiftKey = false) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })); });
}

it('uses the owning view dimensions independently for floating and covered Ask views', async () => {
  bounds.set('main', { width: 1000, height: 800 });
  bounds.set('side', { width: 420, height: 800 });
  const container = await render(<><Harness scope="main" /><Harness scope="side" /></>);
  const main = container.querySelector('[data-owner="main"] .lab-ask-viewport')!;
  const side = container.querySelector('[data-owner="side"] .lab-ask-viewport')!;
  expect(main.getAttribute('data-presentation')).toBe('floating');
  expect(side.getAttribute('data-presentation')).toBe('overlay');
  bounds.set('main', { width: 1000, height: 400 });
  bounds.set('side', { width: 650, height: 800 });
  await act(async () => { for (const update of observers) update(); });
  expect(main.getAttribute('data-presentation')).toBe('overlay');
  expect(side.getAttribute('data-presentation')).toBe('floating');
});

it('preserves per-source geometry without sharing it with another Ask', async () => {
  bounds.set('main', { width: 1000, height: 800 });
  bounds.set('side', { width: 1000, height: 800 });
  const first = await render(<Harness scope="main" />);
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowLeft');
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowDown', true);
  const saved = geometry(first.querySelector('section')!);
  expect(saved).toMatchObject({ width: 430, height: 600 });
  await unmount(first);
  const restored = await render(<><Harness scope="main" /><Harness scope="side" /></>);
  expect(geometry(restored.querySelector('[data-owner="main"] section')!)).toEqual(saved);
  expect(geometry(restored.querySelector('[data-owner="side"] section')!)).toMatchObject({ width: 440, height: 560 });
});

it('keeps source-specific geometry in memory when clear-on-close protection is enabled', async () => {
  localStorage.setItem('agent-remote:clear-cache-on-close', 'true');
  bounds.set('private-main', { width: 1000, height: 800 });
  const first = await render(<Harness scope="private-main" />);
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowLeft');
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowDown', true);
  const saved = geometry(first.querySelector('section')!);
  expect(Object.keys(localStorage).some(key => key.includes('private-main'))).toBe(false);
  await unmount(first);
  const restored = await render(<Harness scope="private-main" />);
  expect(geometry(restored.querySelector('section')!)).toEqual(saved);
  expect(Object.keys(localStorage).some(key => key.includes('private-main'))).toBe(false);
});

it('clamps resized windows to the source view and restores preferred height after a short layout', async () => {
  bounds.set('main', { width: 1000, height: 800 });
  const container = await render(<Harness scope="main" />);
  const panel = container.querySelector('section')!;
  const handle = container.querySelector('.lab-ask-resize')!;
  await key(handle, 'ArrowLeft');
  await key(handle, 'ArrowDown', true);
  const saved = geometry(panel);
  bounds.set('main', { width: 650, height: 480 });
  await act(async () => { for (const update of observers) update(); });
  const compact = geometry(panel);
  expect(compact.left! + compact.width!).toBeLessThanOrEqual(638);
  expect(compact.top! + compact.height!).toBeLessThanOrEqual(468);
  await key(handle, 'ArrowLeft');
  bounds.set('main', { width: 1000, height: 800 });
  await act(async () => { for (const update of observers) update(); });
  expect(geometry(panel)).toMatchObject({ width: saved.width! - 10, height: saved.height });
  bounds.set('main', { width: 390, height: 800 });
  await act(async () => { for (const update of observers) update(); });
  const before = geometry(panel);
  await key(handle, 'ArrowRight');
  expect(geometry(panel)).toEqual(before);
});
it('retains the latest failed geometry after unmount and retries only current edits', async () => {
  bounds.set('failed-geometry', { width: 1000, height: 800 });
  const container = await render(<Harness scope="failed-geometry" />);
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
  await key(container.querySelector('.lab-ask-resize')!, 'ArrowLeft');
  const snapshot = inspectAskPosition('failed-geometry');
  expect(snapshot).toMatchObject({ status: 'failed', size: { width: 430 }, retention: 'page' });
  await unmount(container); denied.mockRestore();
  expect(flushAskPosition('failed-geometry', snapshot.revision, () => false).status).toBe('cancelled');
  expect(flushAskPosition('failed-geometry', snapshot.revision, () => true)).toMatchObject({ status: 'ready', size: { width: 430 }, retention: 'local' });
  expect(JSON.parse(localStorage.getItem('agent-remote-ask:failed-geometry:window-size')!)).toMatchObject({ width: 430 });
});

it.each(['resize', 'move'])('writes source-anchored Ask geometry after %s and restores it after remount', async action => {
  const scope = 'https://shared-ask-geometry.test';
  const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'source', agentId: 'source-agent', title: 'Source' };
  const slot = createCompositionSlot('source-slot', source, scope), owner = createAskOwner(slot, scope);
  const document = createCompositionDocument(scope, [slot]); document.asks = [owner]; document.primary = slot.id;
  let shared: WorkspaceWindow = { schemaVersion: 3, id: 'geometry-window', revision: 0, title: 'Window',
    selectedPrimaryViewId: 'main', selectedViewId: 'shared-ask', views: [createWindowView('main', windowSessionBinding(source), 'primary'),
      { ...createWindowView('shared-ask', windowSessionBinding({ ...source, nativeSessionId: 'ask-native' }), 'float'), closeWith: 'main',
        feature: createWindowFeature({ kind: 'ask', id: 'independent-shared-feature', source }), bindingPolicy: 'managed' }] };
  bindWindowCompositionSlot(document, shared.id, 'main', source, slot.id);
  bounds.set(owner.geometryScope, { width: 1000, height: 800 });
  function SharedHarness() {
    const [window, changed] = useState(shared);
    return <WindowLayoutContext.Provider value={{ window, resolveViewId: id => resolveCompositionWindowViewId(document, window, id),
      operate(operation) { shared = applyWindowOperation(shared, operation); changed(shared); } }}>
      <Harness scope={owner.geometryScope} besideAnchor />
    </WindowLayoutContext.Provider>;
  }
  const first = await render(<SharedHarness />);
  if (action === 'resize') {
    const resize = first.querySelector('.lab-ask-resize')!;
    for (const shift of [true, false, false]) await key(resize, 'ArrowLeft', shift);
    for (const shift of [true, true, false, false]) await key(resize, 'ArrowDown', shift);
  } else {
    const panel = first.querySelector('section')!, heading = first.querySelector('.lab-ask-heading')!;
    Object.assign(panel, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() });
    const origin = panel.getBoundingClientRect();
    const pointer = (target: Element, type: string, dx = 0, dy = 0) => target.dispatchEvent(Object.assign(new MouseEvent(type, {
      clientX: origin.left + 20 + dx, clientY: origin.top + 10 + dy, bubbles: true, cancelable: true, button: 0,
    }), { pointerId: 1, isPrimary: true }));
    await act(async () => { pointer(heading, 'pointerdown'); pointer(panel, 'pointermove', -120, 40); pointer(panel, 'pointerup', -120, 40); });
    expect(panel.getBoundingClientRect()).toMatchObject({ x: origin.x - 120, y: origin.y + 40 });
  }
  const resized = geometry(first.querySelector('section')!);
  const size = action === 'resize' ? { width: 380, height: 660 } : { width: 440, height: 560 };
  expect(resized).toMatchObject(size);
  expect(shared.views.find(view => view.id === 'shared-ask')?.geometry).toEqual({ x: resized.left, y: resized.top, ...size });
  expect(shared.views.find(view => view.id === 'main')?.geometry).toBeUndefined();
  expect(inspectAskPosition(owner.geometryScope).size).toBeUndefined();
  await unmount(first);
  shared = JSON.parse(JSON.stringify(shared)) as WorkspaceWindow;
  const restored = await render(<SharedHarness />);
  expect(geometry(restored.querySelector('section')!)).toEqual(resized);
});
