import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react';

interface ReadingAnchor { key: string; offset: number }
export interface TimelineReadingPosition { following: boolean; anchor?: ReadingAnchor }
export type TimelineReadingPositions = Map<string, TimelineReadingPosition>;
export interface TimelineReadingContinuityPosition { following: boolean; scrollTop?: number }
export type TimelineReadingContinuityPositions = Map<string, TimelineReadingContinuityPosition>;
export interface TimelineReadingContinuity { identity: string; positions: TimelineReadingContinuityPositions }

export function useTimelineScroll(identity: string, visible = true, positions?: TimelineReadingPositions, continuity?: TimelineReadingContinuity) {
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
      viewport.scrollTop = viewport.scrollHeight;
    } else if (anchor.current) {
      const saved = anchor.current;
      const entry = Array.from(viewport.querySelectorAll<HTMLElement>('[data-entry-key]')).find((element) => element.dataset.entryKey === saved.key);
      if (entry) viewport.scrollTop += entry.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset;
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
    } else if (viewport.scrollTop > lastScrollTop.current && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 64) {
      following.current = true;
    }
    expectedScroll.current = undefined;
    lastScrollTop.current = viewport.scrollTop;
    captureAnchor();
    updateLatest(viewport);
  }, []);

  function scrollToLatest(): void {
    draggingScrollbar.current = false;
    following.current = true;
    updatePosition();
  }

  async function loadOlder(action: () => void | Promise<void>): Promise<void> {
    captureAnchor();
    following.current = false;
    captureReadingContinuity();
    await action();
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    const viewport = event.currentTarget;
    if (event.pointerType !== 'mouse' || event.target !== viewport || event.clientX < viewport.getBoundingClientRect().right - 16) return;
    draggingScrollbar.current = true;
  }

  function onWheel(event: WheelEvent<HTMLDivElement>): void {
    if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) pauseFollowing();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const movesUp = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey && event.target === event.currentTarget);
    if (movesUp && event.currentTarget.scrollTop > 0) pauseFollowing();
  }

  function onTouchMove(event: TouchEvent<HTMLDivElement>): void {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchY.current !== undefined && y > touchY.current && event.currentTarget.scrollTop > 0) pauseFollowing();
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
    viewportRef, contentRef, onScroll, showLatest, scrollToLatest, loadOlder,
    onWheel, onPointerDown, onKeyDown, onFocus,
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => { touchY.current = event.touches[0]?.clientY; },
    onTouchMove,
  };
}
