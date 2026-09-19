import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { ToastProvider, useFeedbackToast } from './Toast.js';

afterEach(() => vi.useRealTimers());
function Feedback({ message = 'The Host did not answer.' }: { message?: string }) {
  useFeedbackToast('Session connection', message, 'error');
  return <p role="alert">{message}</p>;
}

it('counts down and dismisses the toast while retaining the inline error', async () => {
  vi.useFakeTimers();
  const container = await render(<ToastProvider><Feedback /></ToastProvider>);
  expect(container.querySelector('.lab-toast')?.textContent).toContain('Closes in 10s');
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(container.querySelector('.lab-toast')?.textContent).toContain('Closes in 6s');
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(container.querySelector('.lab-toast')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The Host did not answer.');
});

it('pauses while focused and supports Escape without clearing the underlying error', async () => {
  vi.useFakeTimers();
  const container = await render(<ToastProvider><Feedback /></ToastProvider>);
  const close = container.querySelector<HTMLButtonElement>('.lab-toast button')!;
  await act(async () => close.focus());
  await act(async () => vi.advanceTimersByTimeAsync(12000));
  expect(container.querySelector('.lab-toast')).not.toBeNull();
  expect(container.querySelector('.lab-toast')?.textContent).toContain('Auto-dismiss paused');
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('.lab-toast')).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it('does not redisplay an unchanged recurring failure after manual dismissal', async () => {
  vi.useFakeTimers();
  function Repeated() {
    const [attempt, setAttempt] = useState(0);
    useFeedbackToast('Session connection', 'Still waiting', 'info');
    return <button onClick={() => setAttempt(attempt + 1)}>Retry {attempt}</button>;
  }
  const container = await render(<ToastProvider><Repeated /></ToastProvider>);
  await act(async () => container.querySelector<HTMLButtonElement>('.lab-toast button')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelector('.lab-toast')).toBeNull();
});


it('pauses when the page is hidden and resumes the remaining countdown', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  const container = await render(<ToastProvider><Feedback /></ToastProvider>);
  try {
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    await act(async () => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(container.querySelector('.lab-toast')).not.toBeNull();
    await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => vi.advanceTimersByTimeAsync(7000));
    expect(container.querySelector('.lab-toast')).toBeNull();
  } finally { visibility.mockRestore(); }
});

it('limits simultaneous notifications and updates a source in place', async () => {
  function Sources() {
    const [message, setMessage] = useState('First failure');
    useFeedbackToast('First', 'One'); useFeedbackToast('Second', 'Two'); useFeedbackToast('Third', 'Three'); useFeedbackToast('Fourth', message);
    return <button onClick={() => setMessage('Updated failure')}>Update</button>;
  }
  const container = await render(<ToastProvider><Sources /></ToastProvider>);
  expect(container.querySelectorAll('.lab-toast')).toHaveLength(3);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelectorAll('.lab-toast')).toHaveLength(3);
  expect(container.querySelector('.lab-toast-region')?.textContent).toContain('Updated failure');
  expect(container.querySelector('.lab-toast-region')?.textContent).not.toContain('First failure');
});


it('gives an updated error its full countdown after an opening status', async () => {
  vi.useFakeTimers();
  function Changes() {
    const [failed, setFailed] = useState(false);
    useFeedbackToast('Session connection', failed ? 'Native runtime unavailable' : 'Opening session', failed ? 'error' : 'info');
    return <button onClick={() => setFailed(true)}>Fail</button>;
  }
  const container = await render(<ToastProvider><Changes /></ToastProvider>);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelectorAll('.lab-toast')).toHaveLength(1);
  expect(container.querySelector('.lab-toast')?.textContent).toContain('Closes in 10s');
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(container.querySelector('.lab-toast')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.querySelector('.lab-toast')).toBeNull();
});
