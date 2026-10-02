import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { useImageDismiss } from './useImageDismiss.js';

let dismiss!: ReturnType<typeof useImageDismiss>;
const onClose = vi.fn();
const onMotion = vi.fn();

function Harness() {
  dismiss = useImageDismiss(onClose, onMotion);
  return <output>{dismiss.motion.phase}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  onClose.mockClear();
  onMotion.mockClear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('dismisses a quick downward flick even when only one move is delivered', async () => {
  const container = await render(<Harness />);
  await act(async () => {
    dismiss.begin(0);
    dismiss.move(0, 80, 40, 700);
    dismiss.finish(50, 700);
  });
  expect(container.textContent).toBe('closing');
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(onClose).toHaveBeenCalledOnce();
});

it('returns to the viewer when a long drag is moving back upward on release', async () => {
  const container = await render(<Harness />);
  await act(async () => {
    dismiss.begin(0);
    dismiss.move(30, 320, 100, 700);
    dismiss.move(20, 240, 160, 700);
    dismiss.finish(170, 700);
  });
  expect(container.textContent).toBe('settling');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.textContent).toBe('idle');
  expect(dismiss.motion).toMatchObject({ x: 0, y: 0, scale: 1, progress: 0 });
  expect(onClose).not.toHaveBeenCalled();
});

it('does not reuse flick velocity after holding a short drag still', async () => {
  const container = await render(<Harness />);
  await act(async () => {
    dismiss.begin(0);
    dismiss.move(0, 80, 40, 700);
    dismiss.finish(300, 700);
  });
  expect(container.textContent).toBe('settling');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.textContent).toBe('idle');
  expect(onClose).not.toHaveBeenCalled();
});

it.each([true, false])('cancels a large drag without closing (animate: %s)', async animate => {
  const container = await render(<Harness />);
  await act(async () => {
    dismiss.begin(0);
    dismiss.move(40, 320, 100, 700);
  });
  expect(dismiss.motion.y).toBeGreaterThan(0);
  expect(dismiss.motion.progress).toBeGreaterThan(0);
  await act(async () => dismiss.cancel(animate));
  expect(dismiss.motion).toMatchObject({ x: 0, y: 0, scale: 1, progress: 0 });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.textContent).toBe('idle');
  expect(onClose).not.toHaveBeenCalled();
});

it('closes immediately for reduced motion without scheduling an exit animation', async () => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })));
  await render(<Harness />);
  await act(async () => {
    dismiss.begin(0);
    dismiss.move(0, 260, 200, 700);
    dismiss.finish(220, 700);
  });
  expect(onClose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(onClose).toHaveBeenCalledOnce();
});

it('cancels an outstanding close callback when the viewer unmounts', async () => {
  const container = await render(<Harness />);
  await act(async () => {
    dismiss.begin(0);
    dismiss.move(0, 260, 200, 700);
    dismiss.finish(220, 700);
  });
  expect(container.textContent).toBe('closing');
  expect(onClose).not.toHaveBeenCalled();
  await unmount(container);
  const updates = onMotion.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(onClose).not.toHaveBeenCalled();
  expect(onMotion).toHaveBeenCalledTimes(updates);
});
