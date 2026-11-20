import { afterEach, expect, it } from 'vitest';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { render } from '../test/setup.js';
import { SidebarResize, useSidebarWidth } from './SidebarResize.js';

afterEach(() => localStorage.clear());

function Probe({ inspector = false }: { inspector?: boolean }) {
  const sidebar = useSidebarWidth(inspector);
  return <SidebarResize width={sidebar.width} maximum={sidebar.maximum} onChange={sidebar.setWidth} />;
}

it('starts at 260 and keeps a saved width inside 220–360', async () => {
  const fresh = await render(<Probe />);
  const handle = fresh.querySelector('[role="separator"]')!;
  expect(handle.getAttribute('aria-valuenow')).toBe('260');
  expect(handle.getAttribute('aria-valuemin')).toBe('220');
  localStorage.setItem('agent-remote.sidebar-width', '500');
  const clamped = await render(<Probe />);
  expect(clamped.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('360');
  localStorage.setItem('agent-remote.sidebar-width', '100');
  const raised = await render(<Probe />);
  expect(raised.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('220');
  localStorage.setItem('agent-remote.sidebar-width', 'wide');
  const fallback = await render(<Probe />);
  expect(fallback.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('260');
  localStorage.setItem('agent-remote.sidebar-width', '300');
  const kept = await render(<Probe />);
  expect(kept.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('300');
});

it('caps the width at 220 when a narrow viewport also shows the inspector', async () => {
  const innerWidth = window.innerWidth;
  try {
    window.innerWidth = 1000;
    localStorage.setItem('agent-remote.sidebar-width', '300');
    const handle = (await render(<Probe inspector />)).querySelector('[role="separator"]')!;
    expect(handle.getAttribute('aria-valuemax')).toBe('220');
    expect(handle.getAttribute('aria-valuenow')).toBe('220');
  } finally { window.innerWidth = innerWidth; }
});

it('words the handle in Chinese', async () => {
  const container = await render(<LocaleContext.Provider value="zh"><Probe /></LocaleContext.Provider>);
  const handle = container.querySelector('[role="separator"]')!;
  expect(handle.getAttribute('aria-label')).toBe('侧边栏宽度');
  expect(handle.getAttribute('aria-valuetext')).toBe('260 像素');
});

it('gives the sidebar way at the smallest desktop width so the stage keeps its room beside the rail and the inspector', async () => {
  const innerWidth = window.innerWidth;
  try {
    window.innerWidth = 1181;
    localStorage.setItem('agent-remote.sidebar-width', '360');
    const open = (await render(<Probe inspector />)).querySelector('[role="separator"]')!;
    expect(open.getAttribute('aria-valuenow')).toBe('301');
    const closed = (await render(<Probe />)).querySelector('[role="separator"]')!;
    expect(closed.getAttribute('aria-valuenow')).toBe('360');
  } finally { window.innerWidth = innerWidth; }
});
