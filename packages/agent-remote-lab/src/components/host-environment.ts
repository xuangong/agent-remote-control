import type { RemoteHost } from './HostPairing.js';

export function hostEnvironmentLabels(host: RemoteHost): string[] {
  const value = host.environment;
  if (!value) return [];
  return [value.os.name, value.os.arch, ...(value.wsl ? ['WSL'] : []), ...(value.container ? ['Container'] : []),
    ...(value.shell.name ? [value.shell.name] : []),
    ...value.browsers.filter(item => item.status === 'found').map(item => item.name),
    ...(value.vscode.status === 'found' ? ['VS Code'] : [])];
}
export function hostDisplayLabel(host: RemoteHost): string {
  return [host.name, host.online ? 'Online' : 'Offline', ...(host.access === 'shared' ? ['Shared'] : []),
    ...(host.environment ? hostEnvironmentLabels(host) : ['Environment unknown'])].join(' · ');
}

export function matchesHostEnvironment(host: RemoteHost, query: string): boolean {
  const value = host.environment;
  const terms = [host.name, host.online ? 'online' : 'offline', ...hostEnvironmentLabels(host),
    ...(host.providers ?? []).flatMap(item => [item.providerId, item.displayName]), host.providerId ?? '',
    value?.os.platform === 'darwin' ? 'mac macos' : value?.os.platform === 'win32' ? 'windows win' : value?.os.platform ?? '',
    ...(value?.shells ?? []).filter(item => item.status === 'found').map(item => item.name),
    value?.vscode.status === 'found' ? 'vscode' : ''].join(' ').toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every(term => terms.includes(term));
}
