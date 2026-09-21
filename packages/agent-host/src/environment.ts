import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { arch, homedir, platform, release, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import type { HostDetectionStatus, HostEnvironment } from '@agent-remote-controller/agent-remote-protocol';

/** Probe boundary keeps platform fixtures independent of the machine running tests. */
export interface EnvironmentProbe {
  platform: string; arch: string; release: string; home: string; env: NodeJS.ProcessEnv;
  userShell(): string | undefined; now(): number;
  read(path: string): Promise<string | undefined>;
  available(path: string, executable?: boolean): Promise<HostDetectionStatus>;
}
const nativeProbe = (env: NodeJS.ProcessEnv): EnvironmentProbe => ({
  platform: platform(), arch: arch(), release: release(), home: homedir(), env,
  userShell: () => userInfo().shell ?? undefined, now: Date.now,
  read: async path => { try { return await readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(300) }); } catch { return undefined; } },
  available: async (path, executable) => {
    try { if (executable && !(await stat(path)).isFile()) return 'not-found'; await access(path, executable && process.platform !== 'win32' ? constants.X_OK : constants.F_OK); return 'found'; }
    catch (error) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'not-found' : 'unknown'; }
  },
});
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160);

async function bounded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(work), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), 350); })]); }
  catch { return fallback; }
  finally { clearTimeout(timer); }
}

export async function detectHostEnvironment(probe: EnvironmentProbe = nativeProbe(process.env), environment?: NodeJS.ProcessEnv): Promise<HostEnvironment> {
  if (environment) probe = { ...probe, env: environment };
  const windows = probe.platform === 'win32';
  const paths = windows ? win32 : posix;
  const env = (key: string) => windows ? Object.entries(probe.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : probe.env[key];
  const available = async (path: string, executable = true): Promise<HostDetectionStatus> => {
    return bounded(() => probe.available(path, executable), 'unknown');
  };
  const find = async (commands: string[], locations: string[] = []): Promise<HostDetectionStatus> => {
    const directories = [...(env('PATH') ?? '').split(windows ? ';' : ':').filter(path => paths.isAbsolute(path)).slice(0, 32),
      ...(windows ? [] : ['/bin', '/usr/bin', '/usr/local/bin', ...(probe.platform === 'darwin' ? ['/opt/homebrew/bin'] : ['/snap/bin'])])];
    const candidates = [...locations, ...directories.flatMap(directory => commands.flatMap(command =>
      (windows ? ['.exe', '.cmd', '.bat', ''] : ['']).map(extension => paths.join(directory, command + extension))))];
    const results = await Promise.all([...new Set(candidates)].map(path => available(path)));
    return results.includes('found') ? 'found' : !results.length || results.includes('unknown') ? 'unknown' : 'not-found';
  };
  const mac = (app: string, executable: string) => probe.platform === 'darwin'
    ? ['/Applications', paths.join(probe.home, 'Applications'), '/System/Applications'].map(root => paths.join(root, `${app}.app`, 'Contents', executable)) : [];
  const win = (relative: string) => windows ? [env('ProgramFiles'), env('ProgramFiles(x86)'), env('LOCALAPPDATA')]
    .filter((root): root is string => !!root).map(root => paths.join(root, relative)) : [];
  const browsers = [
    { id: 'chrome', name: 'Chrome', commands: ['google-chrome', 'google-chrome-stable'], locations: [...mac('Google Chrome', 'MacOS/Google Chrome'), ...win('Google/Chrome/Application/chrome.exe')] },
    { id: 'chromium', name: 'Chromium', commands: ['chromium', 'chromium-browser'], locations: [...mac('Chromium', 'MacOS/Chromium'), ...win('Chromium/Application/chrome.exe')] },
    { id: 'firefox', name: 'Firefox', commands: ['firefox'], locations: [...mac('Firefox', 'MacOS/firefox'), ...win('Mozilla Firefox/firefox.exe')] },
    { id: 'edge', name: 'Edge', commands: ['microsoft-edge', 'microsoft-edge-stable'], locations: [...mac('Microsoft Edge', 'MacOS/Microsoft Edge'), ...win('Microsoft/Edge/Application/msedge.exe')] },
    { id: 'brave', name: 'Brave', commands: ['brave-browser'], locations: [...mac('Brave Browser', 'MacOS/Brave Browser'), ...win('BraveSoftware/Brave-Browser/Application/brave.exe')] },
    ...(probe.platform === 'darwin' ? [{ id: 'safari', name: 'Safari', commands: [], locations: mac('Safari', 'MacOS/Safari') }] : []),
  ];
  let shell: HostEnvironment['shell'] = { source: 'unknown' };
  let accountShell: string | undefined;
  try { accountShell = windows ? undefined : probe.userShell(); } catch {}
  const shellPath = accountShell || (windows ? env('ComSpec') : env('SHELL'));
  if (shellPath) { const name = clean(paths.basename(shellPath).replace(/\.exe$/i, '')); if (name) shell = { name, source: accountShell ? 'account' : 'environment' }; }
  let osName = ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[probe.platform] ?? probe.platform;
  if (probe.platform === 'linux') {
    try {
      const data = await bounded(() => probe.read('/etc/os-release'), undefined);
      const name = data?.match(/^PRETTY_NAME=(?:"([^"\n]*)"|'([^'\n]*)'|([^\n]*))$/m);
      osName = clean(name?.[1] ?? name?.[2] ?? name?.[3] ?? '') || osName;
    } catch {}
  }
  const containerChecks = probe.platform === 'linux' ? await Promise.all(['/.dockerenv', '/run/.containerenv'].map(path => available(path, false))) : [];
  const shellCommands = windows ? ['pwsh', 'powershell', 'cmd'] : ['bash', 'zsh', 'fish', 'sh'];
  const [browserResults, shellResults, vscode] = await Promise.all([
    Promise.all(browsers.map(async ({ id, name, commands, locations }) => ({ id, name, status: await find(commands, locations) }))),
    Promise.all(shellCommands.map(async name => ({ id: name, name, status: await find([name], windows && env('SystemRoot')
      ? name === 'cmd' ? [paths.join(env('SystemRoot')!, 'System32/cmd.exe')]
        : name === 'powershell' ? [paths.join(env('SystemRoot')!, 'System32/WindowsPowerShell/v1.0/powershell.exe')] : [] : []) }))),
    find(['code', 'code-insiders', ...(env('AGENT_HOST_VSCODE') && !paths.isAbsolute(env('AGENT_HOST_VSCODE')!) ? [env('AGENT_HOST_VSCODE')!] : [])], [...mac('Visual Studio Code', 'Resources/app/bin/code'), ...mac('Visual Studio Code - Insiders', 'Resources/app/bin/code-insiders'),
      ...win('Microsoft VS Code/bin/code.cmd'), ...win('Programs/Microsoft VS Code/bin/code.cmd'), ...(env('AGENT_HOST_VSCODE') && paths.isAbsolute(env('AGENT_HOST_VSCODE')!) ? [env('AGENT_HOST_VSCODE')!] : [])]),
  ]);
  return { detectedAt: probe.now(), os: { platform: clean(probe.platform), name: osName, arch: clean(probe.arch), release: clean(probe.release) || 'unknown' },
    wsl: probe.platform === 'linux' && (/microsoft/i.test(probe.release) || !!env('WSL_DISTRO_NAME') || !!env('WSL_INTEROP')),
    container: containerChecks.includes('found') || !!env('container') ? true : containerChecks.includes('unknown') ? null : false,
    shell, shells: shellResults, browsers: browserResults, vscode: { status: vscode } };
}
