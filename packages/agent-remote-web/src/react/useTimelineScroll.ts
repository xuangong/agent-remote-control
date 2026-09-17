import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react';

interface ReadingAnchor { key: string; offset: number }
export interface TimelineReadingPosition { following: boolean; anchor?: ReadingAnchor }
export type TimelineReadingPositions = Map<string, TimelineReadingPosition>;
export interface TimelineReadingContinuityPosition { following: boolean; scrollTop?: number }
export type TimelineReadingContinuityPositions = Map<string, TimelineReadingContinuityPosition>;
export interface TimelineReadingContinuity { identity: string; positions: TimelineReadingContinuityPositions }

interface TimelineHistoryLoading { hasOlder: boolean; cursor?: string; load(): void | Promise<void> }

export function useTimelineScroll(identity: string, visible = true, positions?: TimelineReadingPositions, continuity?: TimelineReadingContinuity, history?: TimelineHistoryLoading) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<ReadingAnchor>();
  const expectedScroll = useRef<number>();
  const lastScrollTop = useRef(0);
  const draggingScrollbar = useRef(false);
  const touchY = useRef<number>();
  const currentIdentity = useRef<string>();
  const pendingScrollTop = useRef<number>();
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const continuityRef = useRef(continuity);
  continuityRef.current = continuity;
  const isVisible = useRef(visible);
  isVisible.current = visible;
  const [showLatest, setShowLatest] = useState(false);
  const latestVisible = useRef(false);
  const historyRef = useRef(history);
  historyRef.current = history;
  const loading = useRef<{ identity: string; promise: Promise<void> }>();
  const attemptedCursor = useRef<string>();
  const historyIntent = useRef(false);
  const [historyState, setHistoryState] = useState<{ identity: string; pending: boolean; error?: string }>();

  function prefetchHistory(): void {
    const viewport = viewportRef.current;
    const source = historyRef.current;
    if (!viewport || !isVisible.current || following.current || !historyIntent.current || !source?.hasOlder || !source.cursor || loading.current) return;
    if (viewport.scrollTop > Math.max(600, viewport.clientHeight * 1.5) || attemptedCursor.current === source.cursor) return;
    attemptedCursor.current = source.cursor;
    void loadOlder(source.load).catch(() => {});
  }

  function updateLatest(viewport: HTMLDivElement): void {
    const next = !following.current && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 64;
    if (latestVisible.current === next) return;
    latestVisible.current = next;
    setShowLatest(next);
  }

  function captureReadingContinuity(scrollTop?: number): void {
    const continuity = continuityRef.current;
    if (!continuity) return;
    const previous = continuity.positions.get(continuity.identity);
    continuity.positions.set(continuity.identity, {
      following: following.current,
      scrollTop: scrollTop ?? previous?.scrollTop,
    });
  }

  function captureAnchor(): void {
    const viewport = viewportRef.current;
    if (!viewport || !viewport.clientHeight) return;
    const top = viewport.getBoundingClientRect().top;
    const entry = Array.from(viewport.querySelectorAll<HTMLElement>('[data-entry-key]')).find((element) => element.getBoundingClientRect().bottom > top);
    if (!entry?.dataset.entryKey) {
      // A reconnect can temporarily remove entries before the same epoch returns.
      if (!positionsRef.current) anchor.current = undefined;
      captureReadingContinuity();
      return;
    }
    anchor.current = { key: entry.dataset.entryKey, offset: entry.getBoundingClientRect().top - top };
    if (currentIdentity.current !== undefined) positionsRef.current?.set(currentIdentity.current, {
      following: following.current, anchor: anchor.current,
    });
    captureReadingContinuity(viewport.scrollTop);
  }

  function updatePosition(): void {
    const viewport = viewportRef.current;
    if (!viewport || !isVisible.current || !viewport.clientHeight) return;
    if (following.current) {
      const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      // Native bottom bounce can exceed the scroll range; let it settle without corrective writes.
      if (bottom - viewport.scrollTop > 1) viewport.scrollTop = bottom;
    } else if (anchor.current) {
      const saved = anchor.current;
      const entry = Array.from(viewport.querySelectorAll<HTMLElement>('[data-entry-key]')).find((element) => element.dataset.entryKey === saved.key);
      if (entry) {
        const adjustment = entry.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset;
        if (Math.abs(adjustment) > 1) viewport.scrollTop += adjustment;
      }
    } else if (pendingScrollTop.current !== undefined && viewport.querySelector('[data-entry-key]')) {
      viewport.scrollTop = pendingScrollTop.current;
      pendingScrollTop.current = undefined;
    }
    expectedScroll.current = viewport.scrollTop;
    lastScrollTop.current = viewport.scrollTop;
    captureAnchor();
    updateLatest(viewport);
  }
  const updateRef = useRef(updatePosition);
  updateRef.current = updatePosition;

  useLayoutEffect(() => {
    if (currentIdentity.current !== identity) {
      currentIdentity.current = identity;
      attemptedCursor.current = undefined;
      historyIntent.current = false;
      loading.current = undefined;
      const saved = positionsRef.current?.get(identity);
      const continuity = continuityRef.current?.positions.get(continuityRef.current.identity);
      following.current = saved?.following ?? continuity?.following ?? true;
      anchor.current = saved?.anchor;
      pendingScrollTop.current = !saved && !following.current ? continuity?.scrollTop : undefined;
      expectedScroll.current = undefined;
      draggingScrollbar.current = false;
    }
    updatePosition();
  });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => updateRef.current());
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  function pauseFollowing(): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    following.current = false;
    expectedScroll.current = undefined;
    lastScrollTop.current = viewport.scrollTop;
    captureAnchor();
  }

  useLayoutEffect(() => () => { loading.current = undefined; currentIdentity.current = undefined; }, []);

  useLayoutEffect(() => {
    const end = () => { draggingScrollbar.current = false; };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  const onScroll = useCallback((): void => {
    const viewport = viewportRef.current;
    if (!viewport || !isVisible.current || !viewport.clientHeight) return;
    if (expectedScroll.current !== undefined && Math.abs(viewport.scrollTop - expectedScroll.current) < 1) return;
    if (following.current) {
      // Browser focus and viewport resizing can scroll without a reading gesture.
      if (!draggingScrollbar.current || viewport.scrollTop >= lastScrollTop.current) {
        updateRef.current();
        return;
      }
      following.current = false;
      historyIntent.current = true;
    } else if (viewport.scrollTop > lastScrollTop.current && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1) {
      following.current = true;
    }
    expectedScroll.current = undefined;
    lastScrollTop.current = viewport.scrollTop;
    captureAnchor();
    updateLatest(viewport);
    prefetchHistory();
  }, []);

  function scrollToLatest(): void {
    draggingScrollbar.current = false;
    historyIntent.current = false;
    following.current = true;
    updatePosition();
  }

  function revealEntry(key: string): boolean {
    const viewport = viewportRef.current;
    const entry = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-entry-key]') ?? []).find(node => node.dataset.entryKey === key);
    if (!viewport || !entry || !isVisible.current) return false;
    pauseFollowing();
    historyIntent.current = false;
    const bounds = entry.getBoundingClientRect();
    viewport.scrollTop += bounds.top - viewport.getBoundingClientRect().top - Math.max(0, (viewport.clientHeight - (bounds.bottom - bounds.top)) / 2);
    lastScrollTop.current = viewport.scrollTop;
    expectedScroll.current = viewport.scrollTop;
    captureAnchor();
    updateLatest(viewport);
    entry.focus({ preventScroll: true });
    return true;
  }

  function loadOlder(action: () => void | Promise<void>): Promise<void> {
    if (loading.current && loading.current.identity === currentIdentity.current) return loading.current.promise;
    const requestIdentity = currentIdentity.current ?? identity;
    captureAnchor();
    following.current = false;
    captureReadingContinuity();
    attemptedCursor.current = historyRef.current?.cursor;
    setHistoryState({ identity: requestIdentity, pending: true });
    const promise = Promise.resolve().then(() => {
      if (currentIdentity.current === requestIdentity && loading.current?.promise === promise) return action();
    }).catch((error: unknown) => {
      if (currentIdentity.current === requestIdentity && loading.current?.promise === promise) setHistoryState({ identity: requestIdentity, pending: false, error: error instanceof Error ? error.message : 'Earlier activity could not be loaded.' });
      throw error;
    }).finally(() => {
      if (loading.current?.promise !== promise) return;
      loading.current = undefined;
      if (currentIdentity.current === requestIdentity) setHistoryState((state) => state?.identity === requestIdentity ? { ...state, pending: false } : state);
    });
    loading.current = { identity: requestIdentity, promise };
    return promise;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    const viewport = event.currentTarget;
    if (event.pointerType !== 'mouse' || event.target !== viewport || event.clientX < viewport.getBoundingClientRect().right - 16) return;
    draggingScrollbar.current = true;
  }

  function onWheel(event: WheelEvent<HTMLDivElement>): void {
    if (event.deltaY < 0) { historyIntent.current = true; pauseFollowing(); prefetchHistory(); }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const movesUp = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey && event.target === event.currentTarget);
    if (movesUp) { historyIntent.current = true; pauseFollowing(); prefetchHistory(); }
  }

  function onTouchMove(event: TouchEvent<HTMLDivElement>): void {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY.current !== undefined && y > touchY.current) { historyIntent.current = true; pauseFollowing(); prefetchHistory(); }
    touchY.current = y;
  }

  function onFocus(event: FocusEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) return;
    const viewport = event.currentTarget;
    const bounds = viewport.getBoundingClientRect();
    const control = event.target.getBoundingClientRect();
    if (viewport.scrollTop < lastScrollTop.current || control.top < bounds.top || control.bottom > bounds.bottom) pauseFollowing();
  }

  return {
    viewportRef, contentRef, onScroll, showLatest, scrollToLatest, revealEntry, loadOlder,
    historyLoading: historyState?.identity === identity && historyState.pending,
    historyError: historyState?.identity === identity ? historyState.error : undefined,
    onWheel, onPointerDown, onKeyDown, onFocus,
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => { touchY.current = event.touches[0]?.clientY; },
    onTouchMove,
  };
}
