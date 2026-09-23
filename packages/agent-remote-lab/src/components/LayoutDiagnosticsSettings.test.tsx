import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { clearLayoutDiagnostics, getLayoutDiagnosticsStatus } from '../layout-diagnostics.js';
import { LayoutDiagnosticsSettings } from './LayoutDiagnosticsSettings.js';

afterEach(async () => { await act(async () => clearLayoutDiagnostics()); vi.unstubAllGlobals(); });

it('keeps the report selectable when clipboard access fails and recording survives closing settings', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button data-toggle onClick={() => setOpen(value => !value)}>Settings</button>{open ? <LayoutDiagnosticsSettings /> : null}</>;
  }
  const view = await render(<Harness />);
  expect(view.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  await act(async () => view.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(getLayoutDiagnosticsStatus().recording).toBe(true);
  await act(async () => view.querySelector<HTMLButtonElement>('[data-toggle]')!.click());
  expect(view.querySelector('[role="switch"]')).toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[data-toggle]')!.click());
  expect(view.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  await act(async () => [...view.querySelectorAll('button')].find(button => button.textContent === 'Copy report')!.click());
  expect(getLayoutDiagnosticsStatus().recording).toBe(false);
  const output = view.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(JSON.parse(output.value).format).toBe('arc-layout-diagnostics');
  expect(JSON.parse(output.value).samples.length).toBeGreaterThan(0);
  expect(view.querySelector('[role="status"]')?.textContent).toContain('Select');
  await act(async () => [...view.querySelectorAll('button')].find(button => button.textContent === 'Clear report')!.click());
  expect(getLayoutDiagnosticsStatus().hasRecording).toBe(false);
  expect(view.querySelector('textarea')).toBeNull();
});
