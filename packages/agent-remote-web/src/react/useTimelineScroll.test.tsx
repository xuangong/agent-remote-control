import React, { act, type MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimelineScroll, type TimelineReadingPositions } from './useTimelineScroll.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const positions: TimelineReadingPositions = new Map();
const followingPositions = new Map<string, { following: boolean; scrollTop?: number }>();
let root: Root;
let container: HTMLDivElement;

function Surface({ identity = 'epoch-one', empty = false, entryCount = 10, continuityIdentity, history, firstIndex = 0, onRender, controls }: { controls?: (scroll: ReturnType<typeof useTimelineScroll>) => void; history?: Parameters<typeof useTimelineScroll>[4]; firstIndex?: number; identity?: string; empty?: boolean; entryCount?: number; continuityIdentity?: string; onRender?: (showLatest: boolean) => void }) {
  const scroll = useTimelineScroll(identity, true, positions, continuityIdentity ? { identity: continuityIdentity, positions: followingPositions } : undefined, history);
  controls?.(scroll);
  onRender?.(scroll.showLatest);
  return <div onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove} onWheel={scroll.onWheel} onScroll={scroll.onScroll} ref={(element) => {
    (scroll.viewportRef as MutableRefObject<HTMLDivElement | null>).current = element;
    if (!element || element.dataset.configured) return;
    element.dataset.configured = 'true';
    let top = 0;
    Object.defineProperties(element, {
      clientHeight: { get: () => 100 },
      scrollHeight: { get: () => {
        const height = element.querySelectorAll('[data-entry-key]').length * 100;
        top = Math.max(0, Math.min(top, height - 100));
        return height;
      } },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, element.scrollHeight - 100)); } },
    });
    element.getBoundingClientRect = () => ({ top: 0, bottom: 100 } as DOMRect);
  }}>
    <div ref={scroll.contentRef}>{empty ? null : Array.from({ length: entryCount }, (_, index) => <div key={index} data-entry-key={`${identity}:${index + firstIndex}`} ref={(element) => {
      if (element) element.getBoundingClientRect = () => ({ top: index * 100 - scroll.viewportRef.current!.scrollTop, bottom: (index + 1) * 100 - scroll.viewportRef.current!.scrollTop } as DOMRect);
    }}>Message {index}</div>)}</div>
  </div>;
}

beforeEach(() => {
  positions.clear();
  followingPositions.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const viewport = () => container.firstElementChild as HTMLDivElement;
it('continues following new content after a child consumes a horizontal touch gesture', () => {
  act(() => root.render(<Surface />));
  const target = viewport().firstElementChild!;
  act(() => {
    target.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [{ clientY: 100 }] }));
    const move = Object.assign(new Event('touchmove', { bubbles: true, cancelable: true }), { touches: [{ clientY: 120 }] });
    move.preventDefault();
    target.dispatchEvent(move);
  });
  act(() => root.render(<Surface entryCount={11} />));
  expect(viewport().scrollTop).toBe(1000);
});
function readEarlier() {
  act(() => {
    viewport().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    viewport().scrollTop = 240;
    viewport().dispatchEvent(new Event('scroll'));
  });
}

describe('useTimelineScroll reading memory', () => {
  it('reveals an inspected entry and keeps it anchored when more activity arrives', () => {
    let controls!: ReturnType<typeof useTimelineScroll>;
    act(() => root.render(<Surface controls={value => { controls = value; }} />));
    expect(viewport().scrollTop).toBe(900);
    act(() => { expect(controls.revealEntry('epoch-one:3')).toBe(true); });
    expect(viewport().scrollTop).toBe(300);
    act(() => root.render(<Surface entryCount={12} />));
    expect(viewport().scrollTop).toBe(300);
    expect(positions.get('epoch-one')?.following).toBe(false);
  });

  it('keeps the latest button hidden when scrolling within the bottom threshold', () => {
    const onRender = vi.fn();
    act(() => root.render(<Surface onRender={onRender} />));
    onRender.mockClear();
    act(() => {
      viewport().dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
      viewport().scrollTop = 880;
      viewport().dispatchEvent(new Event('scroll'));
    });
    expect(onRender.mock.calls.every(([showLatest]) => !showLatest)).toBe(true);
    expect(viewport().scrollTop).toBe(880);
  });

  it('restores the reading anchor after the conversation remounts', () => {
    act(() => root.render(<Surface />));
    readEarlier();
    expect(viewport().scrollTop).toBe(240);
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<Surface />));
    expect(viewport().scrollTop).toBe(240);
  });

  it('keeps the anchor through an empty reconnect view and follows a new epoch by default', () => {
    act(() => root.render(<Surface />));
    readEarlier();
    act(() => root.render(<Surface identity="connecting" empty />));
    act(() => root.render(<Surface />));
    expect(viewport().scrollTop).toBe(240);
    act(() => root.render(<Surface identity="epoch-two" />));
    expect(viewport().scrollTop).toBe(900);
  });

  it('keeps an upward reading intent when the session receives a replacement epoch', () => {
    const onRender = vi.fn();
    act(() => root.render(<Surface continuityIdentity="owner-and-public-route" onRender={onRender} />));
    readEarlier();
    onRender.mockClear();
    act(() => root.render(<Surface identity="epoch-two" continuityIdentity="owner-and-public-route" onRender={onRender} />));
    expect(viewport().scrollTop).toBe(240);
    expect(onRender.mock.calls.at(-1)).toEqual([true]);
    expect(positions.get('epoch-two')?.anchor?.key).toMatch(/^epoch-two:/);
  });

  it('restores and clamps the last valid scroll position after an empty replacement view receives its new epoch history', () => {
    const onRender = vi.fn();
    act(() => root.render(<Surface continuityIdentity="owner-and-public-route" onRender={onRender} />));
    readEarlier();
    act(() => root.render(<Surface identity="epoch-two" empty continuityIdentity="owner-and-public-route" onRender={onRender} />));
    expect(viewport().scrollTop).toBe(0);
    onRender.mockClear();
    act(() => root.render(<Surface identity="epoch-two" entryCount={3} continuityIdentity="owner-and-public-route" onRender={onRender} />));
    expect(viewport().scrollTop).toBe(200);
    expect(onRender.mock.calls.at(-1)).toEqual([false]);
    expect(positions.get('epoch-two')?.anchor?.key).toMatch(/^epoch-two:/);
  });

  it('keeps following latest across a replacement epoch when the session was following', () => {
    act(() => root.render(<Surface continuityIdentity="owner-and-public-route" />));
    act(() => root.render(<Surface identity="epoch-two" continuityIdentity="owner-and-public-route" />));
    expect(viewport().scrollTop).toBe(900);
  });
});


it('prefetches before reaching the top, shares the in-flight request, and preserves the visible entry after prepending', async () => {
  let finish!: () => void;
  const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const history = { hasOlder: true, cursor: '0', load };
  act(() => root.render(<Surface history={history} />));
  expect(load).not.toHaveBeenCalled();
  await act(async () => readEarlier());
  expect(viewport().scrollTop).toBe(240);
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => readEarlier());
  expect(load).toHaveBeenCalledTimes(1);
  act(() => { viewport().scrollTop = 180; viewport().dispatchEvent(new Event('scroll')); });
  await act(async () => {
    root.render(<Surface history={{ ...history, cursor: '-10' }} firstIndex={-10} entryCount={20} />);
    finish();
  });
  expect(viewport().scrollTop).toBe(1180);
  expect(load).toHaveBeenCalledTimes(1);
});

it('does not automatically retry a failed cursor or load an exhausted conversation', async () => {
  const load = vi.fn(async () => { throw new Error('Offline'); });
  const history = { hasOlder: true, cursor: '0', load };
  act(() => root.render(<Surface history={history} />));
  await act(async () => readEarlier());
  await act(async () => readEarlier());
  expect(load).toHaveBeenCalledTimes(1);
  act(() => root.render(<Surface identity="another" history={{ ...history, hasOlder: false }} />));
  await act(async () => readEarlier());
  expect(load).toHaveBeenCalledTimes(1);
});


it('lets bottom rubber-banding settle without repeatedly correcting the browser', () => {
  act(() => root.render(<Surface />));
  let nativeTop = 900;
  const write = vi.fn((value: number) => { nativeTop = Math.min(value, viewport().scrollHeight - viewport().clientHeight); });
  Object.defineProperty(viewport(), 'scrollTop', { configurable: true, get: () => nativeTop, set: write });
  for (const top of [912, 940, 924, 903, 900.4, 900]) {
    nativeTop = top;
    act(() => viewport().dispatchEvent(new Event('scroll')));
    act(() => root.render(<Surface />));
    expect(nativeTop).toBe(top);
  }
  expect(write).not.toHaveBeenCalled();
  act(() => root.render(<Surface entryCount={11} />));
  expect(nativeTop).toBe(1000);
});

it('lets a downward gesture reach the end before resuming automatic following', () => {
  act(() => root.render(<Surface />));
  readEarlier();
  act(() => { viewport().scrollTop = 850; viewport().dispatchEvent(new Event('scroll')); });
  expect(viewport().scrollTop).toBe(850);
  act(() => root.render(<Surface />));
  expect(viewport().scrollTop).toBe(850);
  act(() => { viewport().scrollTop = 899.5; viewport().dispatchEvent(new Event('scroll')); });
  act(() => root.render(<Surface entryCount={11} />));
  expect(viewport().scrollTop).toBe(1000);
});

it('finds a reading anchor in long history without measuring every earlier entry', () => {
  act(() => root.render(<Surface entryCount={1000} />));
  const entries = [...container.querySelectorAll<HTMLElement>('[data-entry-key]')];
  let reads = 0;
  for (const entry of entries) {
    const bounds = entry.getBoundingClientRect;
    entry.getBoundingClientRect = () => { reads++; return bounds(); };
  }
  act(() => {
    viewport().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    viewport().scrollTop = 73420;
    viewport().dispatchEvent(new Event('scroll'));
  });
  expect(positions.get('epoch-one')?.anchor?.key).toBe('epoch-one:734');
  expect(reads).toBeLessThan(60);
});

it('positions only when the explicit content revision changes', () => {
  const revision = {};
  let reads = 0;
  function StableSurface({ contentRevision = revision }: { contentRevision?: object }) {
    const scroll = useTimelineScroll('stable', true, positions, undefined, undefined, contentRevision);
    return <div ref={element => {
      (scroll.viewportRef as MutableRefObject<HTMLDivElement | null>).current = element;
      if (element && !element.dataset.configured) {
        element.dataset.configured = 'true';
        Object.defineProperties(element, { clientHeight: { get: () => 100 }, scrollHeight: { get: () => { reads++; return 1000; } } });
      }
    }}><div ref={scroll.contentRef}><div data-entry-key="one">Stable text</div></div></div>;
  }
  act(() => root.render(<StableSurface />));
  reads = 0;
  act(() => root.render(<StableSurface />));
  expect(reads).toBe(0);
  act(() => root.render(<StableSurface contentRevision={{}} />));
  expect(reads).toBeGreaterThan(0);
});
