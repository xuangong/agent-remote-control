import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// These are native test baselines, not product-wide compatibility claims.
const baselines = { claude: '2.1.247', codex: '0.162.0', copilot: '1.0.83', opencode: '2.0.25' };

async function executablePath(selected, cwd, env) {
  const searchPath = [join(cwd, 'node_modules/.bin'), join(root, 'node_modules/.bin'),
    ...(Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '').split(delimiter)];
  const candidates = isAbsolute(selected) || /[\\/]/.test(selected) ? [resolve(cwd, selected)]
    : searchPath.flatMap(directory => process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')].map(extension => join(directory, selected + extension))
      : [join(directory, selected)]);
  for (const path of candidates) {
    try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return await realpath(path); }
    catch {}
  }
  throw new Error(`Executable not found: ${selected}`);
}

function versionOutput(executable, cwd, env, provider, { direct = false } = {}) {
  return new Promise((resolveOutput, reject) => {
    const javascript = !direct && (provider === 'copilot' ? /\.[cm]js$/i : /\.[cm]?js$/i).test(executable);
    const child = spawn(javascript ? process.execPath : executable, [...(javascript ? [executable] : []), '--version'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let output = '', outputBytes = 0, failed;
    const stop = () => {
      if (process.platform === 'win32') {
        spawn(join(env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .on('error', () => child.kill('SIGKILL'));
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); } }
    };
    const timer = setTimeout(() => { failed = new Error('Version probe timed out after 5000ms.'); stop(); }, 5000);
    const collect = (chunk, stdout) => {
      outputBytes += chunk.length; if (!direct || stdout) output += chunk;
      if (outputBytes > 65536) { failed = new Error('Version output exceeded 64 KiB.'); stop(); }
    };
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(failed ?? new Error(`Version probe exited with code ${code}.`));
      else resolveOutput(output.replace(/\r\n/g, '\n').trim());
    });
  });
}

function versionFrom(provider, output) {
  const patterns = {
    claude: /^(\d+\.\d+\.\d+)\s+\(Claude Code\)$/m,
    codex: /^codex-cli\s+(\d+\.\d+\.\d+)$/m,
    copilot: /^(?:GitHub Copilot CLI\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)\.?$/m,
    opencode: /^(?:opencode\s+)?v?(\d+\.\d+\.\d+)$/im,
  };
  return patterns[provider].exec(output)?.[1];
}

function meetsBaseline(actual, target, range) {
  if (range === 'exact') return actual === target;
  const a = actual.split('-')[0].split('.').map(Number), b = target.split('.').map(Number);
  if (range === '2.x' && a[0] !== 2) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return actual === target;
}

/** Probe exactly the native executables selected by each test fixture before starting pnpm. */
export async function verifyNativeTestVersions(mode, env = process.env) {
  const selections = [];
  const add = (provider, variable, fallback, range = 'exact') => selections.push({ provider, variable, selected: env[variable] ?? fallback, range });
  if (['local', 'claude', 'claude-succession-evidence'].includes(mode))
    add('claude', 'AGENT_CLAUDE_TEST_EXECUTABLE', 'claude', mode === 'claude-succession-evidence' ? 'exact' : 'minimum');
  if (mode === 'local') {
    const cwd = join(root, 'packages/agent-remote-lab');
    const manifestPath = resolve(cwd, env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST ?? 'compatibility.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const native = manifest.providers?.find(provider => provider.providerId === 'codex')?.native;
    if (typeof native?.name !== 'string' || typeof native?.version !== 'string') throw new Error(`Missing Codex native target in ${manifestPath}.`);
    selections.push({ provider: 'codex', variable: 'BORGEE_CODEX_TEST_EXECUTABLE', selected: env.BORGEE_CODEX_TEST_EXECUTABLE,
      range: 'exact', target: native.version, expectedOutput: `${native.name} ${native.version}`, direct: true, cwd, manifestPath });
    for (const variable of ['AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE', 'ARC_PROMPT_EDIT_TEST_EXECUTABLE', 'ARC_SESSION_FORK_TEST_EXECUTABLE', 'ARC_CODEX_SUCCESSION_TEST_EXECUTABLE'])
      if (env[variable]) add('codex', variable, undefined, 'minimum');
    if (process.platform === 'win32' && env.AGENT_REMOTE_WINDOWS_CODEX_TEST_EXECUTABLE)
      add('codex', 'AGENT_REMOTE_WINDOWS_CODEX_TEST_EXECUTABLE', undefined, 'minimum');
  }
  if (mode === 'codex-shared') add('codex', 'AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE', undefined, 'minimum');
  if (['local', 'copilot'].includes(mode)) {
    const manifestPath = createRequire(join(root, 'packages/agent-provider-copilot/package.json')).resolve('@github/copilot/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    selections.push({ provider: 'copilot', selected: resolve(dirname(manifestPath), manifest.bin.copilot), packageVersion: manifest.version, variable: 'the @github/copilot native runtime and its cache', range: 'minimum' });
  }
  if (['opencode-native', 'opencode-server-native', 'opencode-succession-evidence', 'opencode-succession-adapter'].includes(mode)
    || (mode === 'host-package' && env.AGENT_OPENCODE_TEST_EXECUTABLE))
    add('opencode', 'AGENT_OPENCODE_TEST_EXECUTABLE', undefined, ['opencode-server-native', 'host-package'].includes(mode) ? 'exact' : '2.x');
  const checked = new Set();
  for (const selection of selections) {
    const { provider, selected, variable, range } = selection;
    const target = selection.target ?? baselines[provider], required = range === 'exact' ? target : `${range === '2.x' ? '2.x, ' : ''}>=${target}`;
    const packageVersion = selection.packageVersion ? `; package=${selection.packageVersion}` : '';
    const manifest = selection.manifestPath ? `; manifest=${selection.manifestPath}` : '';
    let executable = selected ?? '(not selected)', actual = '(unavailable)', profile;
    try {
      if (selection.direct && (!selected || !isAbsolute(selected))) throw new Error(`Set ${variable} to an explicit absolute executable path.`);
      if (!selected) throw new Error(`Set ${variable} to the native executable.`);
      const cwd = selection.cwd ?? join(root, 'packages', `agent-provider-${provider}`);
      executable = await executablePath(selected, cwd, env);
      const key = `${provider}:${range}:${target}:${executable}`;
      if (checked.has(key)) continue;
      if (provider === 'copilot') profile = await mkdtemp(join(tmpdir(), 'arc-native-version-'));
      const probeEnv = profile ? { ...env, COPILOT_HOME: join(profile, 'profile'), GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined } : env;
      const output = await versionOutput(executable, cwd, probeEnv, provider, selection);
      actual = selection.expectedOutput === output ? target : versionFrom(provider, output) ?? '(unrecognized version output)';
      console.log(`Native test preflight: ${provider}; executable=${executable}; actual=${actual}${packageVersion}; required baseline=${required}${manifest}`);
      if (selection.expectedOutput ? output !== selection.expectedOutput : !versionFrom(provider, output) || !meetsBaseline(actual, target, range))
        throw new Error(selection.expectedOutput ? `Selected executable must report exactly ${selection.expectedOutput}.` : 'Selected native version does not match the test baseline.');
      checked.add(key);
    } catch (error) {
      throw new Error(`Native test preflight failed: ${provider}; executable=${executable}; actual=${actual}${packageVersion}; required baseline=${required}${manifest}. ${error.message} Select the required runtime using ${variable}, then rerun the same suite.`, { cause: error });
    } finally { if (profile) await rm(profile, { recursive: true, force: true }); }
  }
}
