import { act, createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import { render } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';

type Editor = HTMLTextAreaElement | HTMLDivElement;
const draft = 'Keep this draft\nAnother line';

beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { vi.useRealTimers(); document.getSelection()?.removeAllRanges(); });

async function composer(rich = false, outerBoundary = false) {
  const state = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
    id: crypto.randomUUID(), providerId: 'test', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z', status: 'idle' as const,
    activeTurn: null, pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' as const },
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      ...(rich ? { imageInput: { mediaTypes: ['image/png' as const], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } : {}) },
  } };
  const send = vi.fn(async () => {});
  const change = vi.fn();
  const collapse = vi.fn();
  const boundary = createRef<HTMLDivElement>();
  const controls = <AgentComposer state={state} draft={draft} onDraftChange={change} onSendMessage={send}
    keyboardDismissBoundaryRef={outerBoundary ? boundary : undefined} />;
  const container = await render(outerBoundary ? <div ref={boundary} role="dialog"><button onClick={collapse}>Collapse input</button>{controls}</div> : controls);
  const editor = container.querySelector<Editor>('[data-testid="prompt-input"]')!;
  await act(async () => editor.focus());
  return { container, editor, send, change, collapse };
}

async function touch(target: Element, type: string, x = 100, y = 100, count = 1, cancelable = true) {
  const event = new Event(type, { bubbles: true, cancelable });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y, screenX: x, screenY: y })) });
  await act(async () => target.dispatchEvent(event));
  return event;
}

async function pointer(target: Element, type: string, y = 100) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'touch', clientX: 100, clientY: y });
  await act(async () => target.dispatchEvent(event));
}

async function click(target: Element, detail = 1) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail });
  await act(async () => target.dispatchEvent(event));
  return event;
}

for (const rich of [false, true]) {
  const label = rich ? 'rich text' : 'textarea';
  it(`dismisses ${label} focus once on a downward swipe and consumes the rest of that gesture`, async () => {
    const { editor, send } = await composer(rich);
    const blur = vi.fn(); editor.addEventListener('blur', blur);
    await touch(editor, 'touchstart');
    expect((await touch(editor, 'touchmove', 101, 106)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);
    expect((await touch(editor, 'touchmove', 102, 126)).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(editor);
    // Keyboard dismissal moves the visual viewport. This remains the same drag.
    expect((await touch(editor, 'touchmove', 102, 80)).defaultPrevented).toBe(true);
    expect((await touch(editor, 'touchend', 102, 80, 0)).defaultPrevented).toBe(true);
    expect(blur).toHaveBeenCalledOnce();
    expect(editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent).toBe(draft);
    expect(send).not.toHaveBeenCalled();
    expect((await touch(editor, 'touchmove', 102, 160)).defaultPrevented).toBe(false);
  });

  it(`dismisses from a scrolled ${label} without scrolling the input or page`, async () => {
    const { editor } = await composer(rich);
    editor.style.overflowY = 'auto';
    Object.defineProperties(editor, { clientHeight: { value: 80 }, scrollHeight: { value: 240 } });
    editor.scrollTop = 45;
    await touch(editor, 'touchstart');
    expect((await touch(editor, 'touchmove', 100, 130)).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(editor);
    expect(editor.scrollTop).toBe(45);
  });

  it(`holds ${label} still on upward movement and dismisses on reversal without returning to the starting point`, async () => {
    const { editor } = await composer(rich);
    vi.useFakeTimers({ toFake: ['Date'] });
    await touch(editor, 'touchstart');
    expect((await touch(editor, 'touchmove', 100, 65)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);
    vi.advanceTimersByTime(600);
    expect((await touch(editor, 'touchmove', 100, 40)).defaultPrevented).toBe(true);
    expect((await touch(editor, 'touchmove', 100, 46)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);
    expect((await touch(editor, 'touchmove', 100, 56)).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(editor);
    expect((await touch(editor, 'touchmove', 100, 70)).defaultPrevented).toBe(true);
  });

  it(`also dismisses ${label} when downward movement starts in a new touch`, async () => {
    const { editor } = await composer(rich);
    await touch(editor, 'touchstart');
    expect((await touch(editor, 'touchmove', 100, 65)).defaultPrevented).toBe(true);
    await touch(editor, 'touchend', 100, 65, 0);
    expect(document.activeElement).toBe(editor);
    await touch(editor, 'touchstart');
    expect((await touch(editor, 'touchmove', 100, 120)).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(editor);
  });

  it(`keeps owning a small ${label} movement when the finger pauses before continuing`, async () => {
    const { editor } = await composer(rich);
    vi.useFakeTimers({ toFake: ['Date'] });
    await touch(editor, 'touchstart');
    expect((await touch(editor, 'touchmove', 100, 96)).defaultPrevented).toBe(true);
    vi.advanceTimersByTime(600);
    expect((await touch(editor, 'touchmove', 100, 40)).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);
    expect((await touch(editor, 'touchmove', 104, 56)).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(editor);
  });

  it(`dismisses ${label} after an upward drag curves sideways and then down`, async () => {
    const { editor } = await composer(rich);
    await touch(editor, 'touchstart', 100, 300);
    for (const [x, y] of [[95, 260], [110, 180], [130, 140], [145, 142], [149, 147], [153, 152]]) {
      expect((await touch(editor, 'touchmove', x, y)).defaultPrevented).toBe(true);
    }
    expect(document.activeElement).not.toBe(editor);
    expect((await touch(editor, 'touchmove', 160, 200)).defaultPrevented).toBe(true);
  });

  it(`leaves ${label} selections and selection-handle drags alone`, async () => {
    const { editor } = await composer(rich);
    const select = () => {
      if (editor instanceof HTMLTextAreaElement) editor.setSelectionRange(0, 4);
      else { const range = document.createRange(); range.setStart(editor.firstChild!, 0); range.setEnd(editor.firstChild!, 4); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); }
    };
    await act(async () => select());
    await touch(editor, 'touchstart');
    expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);
    await act(async () => { if (editor instanceof HTMLTextAreaElement) editor.setSelectionRange(0, 0); else document.getSelection()!.collapse(editor.firstChild!, 0); });
    await touch(editor, 'touchstart');
    await act(async () => select());
    expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);
  });
}

it('does not dismiss from horizontal movement and holds the composer still', async () => {
  const { editor } = await composer();
  await touch(editor, 'touchstart');
  expect((await touch(editor, 'touchmove', 145, 105)).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(editor);
  expect((await touch(editor, 'touchmove', 180, 102)).defaultPrevented).toBe(true);
  expect((await touch(editor, 'touchmove', 220, 106)).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(editor);
});

it('accumulates downward movement from the highest point even with sideways motion', async () => {
  const { editor } = await composer();
  await touch(editor, 'touchstart');
  await touch(editor, 'touchmove', 90, 60);
  expect((await touch(editor, 'touchmove', 150, 69)).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(editor);
  expect((await touch(editor, 'touchmove', 160, 70)).defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(editor);
});

it('still dismisses if the browser has made a later touch event non-cancelable', async () => {
  const { editor } = await composer();
  await touch(editor, 'touchstart');
  await touch(editor, 'touchmove', 100, 65);
  await touch(editor, 'touchmove', 100, 85, 1, false);
  expect(document.activeElement).not.toBe(editor);
});

it('does not capture input scrolling without input focus', async () => {
  const { editor } = await composer();
  await act(async () => editor.blur());
  await touch(editor, 'touchstart');
  expect((await touch(editor, 'touchmove', 100, 65)).defaultPrevented).toBe(false);
});

it('preserves long presses, multiple fingers, and cancelled gestures', async () => {
  const { editor } = await composer();
  vi.useFakeTimers({ toFake: ['Date'] });
  await touch(editor, 'touchstart');
  vi.advanceTimersByTime(500);
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
  await touch(editor, 'touchstart', 100, 100, 2);
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
  await touch(editor, 'touchstart');
  await touch(editor, 'touchmove', 100, 104, 2);
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
  await touch(editor, 'touchstart');
  await touch(editor, 'touchcancel', 100, 100, 0);
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(editor);
});

it.each([false, true])('leaves ongoing IME composition intact (rich: %s)', async rich => {
  const { editor } = await composer(rich);
  await act(async () => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await touch(editor, 'touchstart');
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(editor);
  await act(async () => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await touch(editor, 'touchstart');
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(true);
});

it('dismisses from composer whitespace without touching other composers', async () => {
  const first = await composer();
  const second = await composer();
  await touch(first.container.querySelector('.agent-composer')!, 'touchstart');
  expect((await touch(first.container.querySelector('.agent-composer')!, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(second.editor);
  const root = second.container.querySelector('.agent-composer')!;
  await touch(root, 'touchstart');
  expect((await touch(root, 'touchmove', 100, 140)).defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(second.editor);
});

it.each([false, true])('consumes a drag from toolbar content without opening it, including with selected text (rich: %s)', async rich => {
  const { container, editor } = await composer(rich);
  if (editor instanceof HTMLTextAreaElement) editor.setSelectionRange(0, 4);
  else { const range = document.createRange(); range.selectNodeContents(editor); document.getSelection()!.addRange(range); }
  const button = container.querySelector('[aria-label="Open chat commands"]')!;
  const target = button.firstElementChild ?? button;
  await touch(target, 'touchstart');
  expect((await touch(target, 'touchmove', 100, 70)).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(editor);
  expect((await touch(target, 'touchmove', 100, 80)).defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(editor);
  await touch(target, 'touchend', 100, 80, 0);
  expect((await click(target)).defaultPrevented).toBe(true);
  expect(container.querySelector('.agent-command-menu')).toBeNull();
  // A new tap must not inherit suppression from the preceding drag.
  await touch(target, 'touchstart');
  await touch(target, 'touchend', 100, 100, 0);
  await click(target);
  expect(container.querySelector('.agent-command-menu')).not.toBeNull();
});

it('includes an outer dialog control without consuming its ordinary click', async () => {
  const { container, editor, collapse } = await composer(false, true);
  const button = container.querySelector('button')!;
  await touch(button, 'touchstart');
  await touch(button, 'touchmove', 100, 130);
  await touch(button, 'touchend', 100, 130, 0);
  expect(document.activeElement).not.toBe(editor);
  await click(button);
  expect(collapse).not.toHaveBeenCalled();
  await pointer(button, 'pointerdown');
  await click(button);
  expect(collapse).toHaveBeenCalledOnce();
});

it('preserves keyboard and assistive activation after a toolbar drag', async () => {
  const { container } = await composer();
  const button = container.querySelector('[aria-label="Open chat commands"]')!;
  await touch(button, 'touchstart');
  await touch(button, 'touchmove', 100, 130);
  await touch(button, 'touchend', 100, 130, 0);
  await click(button, 0);
  expect(container.querySelector('.agent-command-menu')).not.toBeNull();
});

it.each(['before', 'during'])('dismisses from a toolbar when IME starts %s its gesture', async timing => {
  const { container, editor } = await composer();
  const button = container.querySelector('[aria-label="Open chat commands"]')!;
  const compose = () => act(async () => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  if (timing === 'before') await compose();
  await touch(button, 'touchstart');
  if (timing === 'during') await compose();
  expect((await touch(button, 'touchmove', 100, 130)).defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(editor);
});

it('preserves assistive Send activation after suppressing a drag click', async () => {
  const { container, send } = await composer();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  button.setPointerCapture = vi.fn();
  await pointer(button, 'pointerdown');
  await touch(button, 'touchstart');
  await pointer(button, 'pointermove', 130);
  await touch(button, 'touchmove', 100, 130);
  await pointer(button, 'pointerup', 130);
  await touch(button, 'touchend', 100, 130, 0);
  await click(button);
  expect(send).not.toHaveBeenCalled();
  await click(button, 0);
  expect(send).toHaveBeenCalledWith(draft);
});

it('leaves the expanded command menu scrollable while its editor stays focused', async () => {
  const { container, editor } = await composer();
  await click(container.querySelector('[aria-label="Open chat commands"]')!);
  const menu = container.querySelector('.agent-command-menu')!;
  await act(async () => editor.focus());
  await touch(menu, 'touchstart');
  expect((await touch(menu, 'touchmove', 100, 140)).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(editor);
});

it('cancels Send hold on the first small drag and never submits on release', async () => {
  const { container, editor, send, change } = await composer();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  button.setPointerCapture = vi.fn();
  vi.useFakeTimers();
  await pointer(button, 'pointerdown');
  await touch(button, 'touchstart');
  await pointer(button, 'pointermove', 94);
  expect((await touch(button, 'touchmove', 100, 94)).defaultPrevented).toBe(true);
  await act(async () => vi.advanceTimersByTime(600));
  expect(change).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
  await pointer(button, 'pointermove', 104);
  expect((await touch(button, 'touchmove', 100, 104)).defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(editor);
  await pointer(button, 'pointerup', 104);
  await touch(button, 'touchend', 100, 104, 0);
  await click(button);
  expect(send).not.toHaveBeenCalled();
});

it('cancels Send hold when a touch pointer moves before the browser emits touchmove', async () => {
  const { container, send, change } = await composer();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  button.setPointerCapture = vi.fn();
  vi.useFakeTimers();
  await pointer(button, 'pointerdown');
  await touch(button, 'touchstart');
  await pointer(button, 'pointermove', 94);
  await act(async () => vi.advanceTimersByTime(600));
  expect(change).not.toHaveBeenCalled();
  await pointer(button, 'pointerup', 94);
  await touch(button, 'touchend', 100, 94, 0);
  await click(button);
  expect(send).not.toHaveBeenCalled();
});

it.each([['tap', 0], ['hold', 0], ['tap', 2], ['hold', 2]] as const)('preserves Send %s with %spx of touch jitter', async (action, jitter) => {
  const { container, send, change } = await composer();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  button.setPointerCapture = vi.fn();
  vi.useFakeTimers();
  await pointer(button, 'pointerdown');
  await touch(button, 'touchstart');
  if (jitter) await pointer(button, 'pointermove', 100 + jitter);
  if (action === 'hold') await act(async () => vi.advanceTimersByTime(500));
  await pointer(button, 'pointerup');
  await touch(button, 'touchend', 100, 100, 0);
  await click(button);
  if (action === 'tap') { expect(send).toHaveBeenCalledWith(draft); expect(change).not.toHaveBeenCalledWith(`${draft}\n`); }
  else { expect(send).not.toHaveBeenCalled(); expect(change).toHaveBeenCalledOnce(); }
});

it('finishes an accepted gesture even if another finger joins while the keyboard is closing', async () => {
  const { editor } = await composer();
  await touch(editor, 'touchstart');
  await touch(editor, 'touchmove', 100, 130);
  await touch(editor, 'touchstart', 100, 130, 2);
  expect((await touch(editor, 'touchmove', 100, 160, 2)).defaultPrevented).toBe(true);
  expect((await touch(editor, 'touchend', 100, 160, 1)).defaultPrevented).toBe(true);
  expect((await touch(editor, 'touchmove', 100, 170)).defaultPrevented).toBe(true);
  await touch(editor, 'touchend', 100, 170, 0);
  expect((await touch(editor, 'touchmove', 100, 190)).defaultPrevented).toBe(false);
});

it('releases interrupted IME state when input focus moves away', async () => {
  const { editor } = await composer();
  await act(async () => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await act(async () => { editor.blur(); editor.focus(); });
  await touch(editor, 'touchstart');
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(true);
});

it('does not dismiss when the editor already owns the gesture', async () => {
  const { editor } = await composer();
  editor.addEventListener('touchmove', event => event.preventDefault());
  await touch(editor, 'touchstart');
  await touch(editor, 'touchmove', 100, 140);
  expect(document.activeElement).toBe(editor);
});

it('retains a drag when another listener cancels an intermediate move', async () => {
  const { editor } = await composer();
  await touch(editor, 'touchstart');
  await touch(editor, 'touchmove', 100, 70);
  editor.addEventListener('touchmove', event => event.preventDefault(), { once: true });
  await touch(editor, 'touchmove', 100, 60);
  expect((await touch(editor, 'touchmove', 104, 85)).defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(editor);
});

it.each(['selection', 'composition', 'focus'])('keeps a captured drag from panning after %s changes without blurring the editor', async change => {
  const { editor } = await composer();
  const blur = vi.fn();
  await touch(editor, 'touchstart');
  await touch(editor, 'touchmove', 100, 70);
  await act(async () => {
    if (change === 'selection') (editor as HTMLTextAreaElement).setSelectionRange(0, 4);
    if (change === 'composition') editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    if (change === 'focus') editor.blur();
  });
  editor.addEventListener('blur', blur);
  expect((await touch(editor, 'touchmove', 100, 110)).defaultPrevented).toBe(true);
  expect((await touch(editor, 'touchmove', 100, 140)).defaultPrevented).toBe(true);
  expect(blur).not.toHaveBeenCalled();
  if (change !== 'focus') expect(document.activeElement).toBe(editor);
  await touch(editor, 'touchend', 100, 140, 0);
  expect((await touch(editor, 'touchmove', 100, 160)).defaultPrevented).toBe(false);
});
