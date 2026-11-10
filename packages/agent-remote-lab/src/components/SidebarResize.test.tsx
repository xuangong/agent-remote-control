import { afterEach, expect, it } from 'vitest';
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
  localStorage.setItem('agent-remote.sidebar-width', '300');
  const kept = await render(<Probe />);
  expect(kept.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('300');
});
