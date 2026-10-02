import { useEffect, useRef, useState } from 'react';

export interface ImageDismissMotion {
  x: number;
  y: number;
  scale: number;
  progress: number;
  phase: 'idle' | 'dragging' | 'settling' | 'closing';
}

const resting: ImageDismissMotion = { x: 0, y: 0, scale: 1, progress: 0, phase: 'idle' };
const settleDuration = 220;
const closeDuration = 180;

/** A reversible drag uses recent motion, so pausing or pushing back never counts as a downward flick. */
export function useImageDismiss(onClose: () => void, onMotion: (motion: ImageDismissMotion) => void) {
  const [motion, setMotion] = useState(resting);
  const current = useRef(resting);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const samples = useRef<Array<{ y: number; time: number }>>([]);
  const callbacks = useRef({ onClose, onMotion });
  callbacks.current = { onClose, onMotion };

  useEffect(() => () => clearTimeout(timer.current), []);

  function update(next: ImageDismissMotion): void {
    current.current = next;
    setMotion(next);
    callbacks.current.onMotion(next);
  }
  function reducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }
  function sample(y: number, time: number): void {
    samples.current = [...samples.current.filter(point => time - point.time <= 100), { y, time }];
  }
  function begin(time: number): void {
    samples.current = [{ y: 0, time }];
  }
  function cancel(animate = true): void {
    if (current.current.phase === 'closing') return;
    clearTimeout(timer.current);
    samples.current = [];
    if (!animate || reducedMotion()) { update(resting); return; }
    update({ ...resting, phase: 'settling' });
    timer.current = setTimeout(() => update(resting), settleDuration);
  }
  function move(x: number, y: number, time: number, height: number): void {
    clearTimeout(timer.current);
    const offset = Math.max(0, y);
    sample(offset, time);
    const progress = Math.min(1, offset / Math.max(1, height * .65));
    // Horizontal drift disappears as the image returns to its fitted position.
    update({ x: x * .65 * Math.min(1, offset / 48), y: offset, scale: 1 - progress * .22, progress, phase: 'dragging' });
  }
  function finish(time: number, height: number): void {
    const value = current.current;
    if (value.phase !== 'dragging') return;
    sample(value.y, time);
    const first = samples.current[0]!;
    const velocity = time > first.time ? (value.y - first.y) / (time - first.time) : 0;
    const threshold = Math.max(110, Math.min(200, height * .22));
    const dismiss = (value.y >= threshold && velocity >= -.15) || (value.y >= 48 && velocity > .65);
    if (!dismiss) { cancel(); return; }
    samples.current = [];
    if (reducedMotion()) { callbacks.current.onClose(); return; }
    update({ ...value, y: Math.max(value.y, height), scale: .78, progress: 1, phase: 'closing' });
    timer.current = setTimeout(() => callbacks.current.onClose(), closeDuration);
  }

  return { motion, begin, move, finish, cancel, closing: () => current.current.phase === 'closing' };
}
