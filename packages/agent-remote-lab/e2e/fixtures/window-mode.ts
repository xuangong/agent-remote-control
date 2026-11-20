/**
 * A fixture of the Window-mode Workbench. On a phone the assistant list is home unless the address names Window mode, a window or
 * a session, so the fixture names Window mode when its address names no mode; a spec that wants Bot mode names `mode=bot`.
 */
export function openInWindowMode(): void {
  const address = new URL(location.href);
  if (address.searchParams.has('mode')) return;
  address.searchParams.set('mode', 'window');
  history.replaceState(history.state, '', address);
}
