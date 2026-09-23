import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearLayoutDiagnostics, exportLayoutDiagnostics, getLayoutDiagnosticsStatus, startLayoutDiagnostics, stopLayoutDiagnostics } from './layout-diagnostics.js';

function readReport() {
  const report = JSON.parse(exportLayoutDiagnostics());
  let previous = {};
  report.samples = report.samples.map((sample: Record<string, unknown>) => previous = { ...previous, ...sample });
  return report;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), {
    width: 390, height: 844, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
  }) });
  document.body.insertAdjacentHTML('beforeend', '<main class="lab-shell"><header class="lab-mobile-navigation">private session title</header><section class="lab-composer-dock"><textarea>private draft</textarea></section></main>');
});
afterEach(() => {
  clearLayoutDiagnostics();
  document.querySelector('.lab-shell')?.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('records geometry only after opting in, retains it when stopped and clears it explicitly', () => {
  expect(getLayoutDiagnosticsStatus().recording).toBe(false);
  expect(readReport().samples).toEqual([]);
  startLayoutDiagnostics();
  Object.assign(window.visualViewport!, { height: 400, offsetTop: 44 });
  window.dispatchEvent(new Event('orientationchange'));
  vi.advanceTimersByTime(40);
  stopLayoutDiagnostics();
  const report = readReport();
  expect(report.samples.some((sample: any) => sample.viewport?.offsetTop === 44 && sample.viewport.height === 400)).toBe(true);
  expect(report.samples.some((sample: any) => sample.shell !== null && sample.header !== null && sample.composers.length === 1)).toBe(true);
  expect(exportLayoutDiagnostics()).not.toContain('private');
  expect(getLayoutDiagnosticsStatus().hasRecording).toBe(true);
  Object.assign(window.visualViewport!, { offsetTop: 88 });
  window.dispatchEvent(new Event('resize'));
  vi.advanceTimersByTime(4000);
  expect(readReport().samples).toEqual(report.samples);
  clearLayoutDiagnostics();
  expect(readReport().samples).toEqual([]);
  expect(getLayoutDiagnosticsStatus().hasRecording).toBe(false);
  expect(document.querySelector('[data-layout-safe-area-probe]')).toBeNull();
});

it('bounds retained samples and automatically stops instead of sampling indefinitely', () => {
  startLayoutDiagnostics();
  for (let i = 0; i < 1200; i++) {
    Object.assign(window.visualViewport!, { offsetTop: i });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(17);
  }
  let report = readReport();
  expect(report.samples.length).toBeLessThanOrEqual(report.limits.maxSamples);
  expect(report.droppedSamples).toBeGreaterThan(0);
  expect(report.samples.at(-1).viewport.offsetTop).toBe(1199);
  vi.advanceTimersByTime(600_000);
  report = readReport();
  expect(getLayoutDiagnosticsStatus().recording).toBe(false);
  expect(report.stopReason).toBe('timeout');
  const count = report.samples.length;
  window.dispatchEvent(new Event('orientationchange'));
  vi.advanceTimersByTime(4000);
  expect(readReport().samples).toHaveLength(count);
});

it('stops frame sampling after settling and while hidden, then captures restoration', () => {
  startLayoutDiagnostics();
  vi.advanceTimersByTime(3500);
  const count = readReport().samples.length;
  vi.advanceTimersByTime(5000);
  expect(readReport().samples).toHaveLength(count);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  const hiddenCount = readReport().samples.length;
  vi.advanceTimersByTime(5000);
  expect(readReport().samples).toHaveLength(hiddenCount);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(readReport().samples.at(-1).reason).toBe('visibilitychange');
  window.dispatchEvent(new Event('pagehide'));
  expect(getLayoutDiagnosticsStatus().recording).toBe(false);
});
