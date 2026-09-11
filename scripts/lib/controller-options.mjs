import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'node:net';

const fields = {
  'state-dir': 'stateDir', workspace: 'workspace', codex: 'codex', claude: 'claude', dsh: 'dsh',
  'codex-home': 'codexHome', 'claude-home': 'claudeHome', 'dsh-home': 'dshHome', 'dsh-repo': 'dshRepo',
  'web-port': 'webPort', 'relay-port': 'relayPort', 'dsh-port': 'dshPort', registry: 'registry', name: 'name',
  'build-dsh': 'buildDsh',
};
const paths = ['stateDir', 'workspace', 'codexHome', 'claudeHome', 'dshHome', 'dshRepo'];
const executables = ['codex', 'claude', 'dsh'];
function resolvePaths(values, cwd) {
  for (const key of paths) if (values[key]) values[key] = resolve(cwd, values[key]);
  for (const key of executables) {
    if (values[key]?.includes('/') || values[key]?.includes('\\')) values[key] = resolve(cwd, values[key]);
  }
  return values;
}

export async function controllerOptions(args, root, cwd, env = process.env) {
  const { values } = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, options: {
    ...Object.fromEntries(Object.keys(fields).map((flag) => [flag, { type: flag === 'build-dsh' ? 'boolean' : 'string' }])),
    config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  let config = {};
  if (values.config) {
    const path = resolve(cwd, values.config);
    try { config = JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new Error(`Cannot read a JSON configuration object from ${path}.`); }
    if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Configuration must be a JSON object.');
    for (const [key, value] of Object.entries(config)) {
      if (!Object.values(fields).includes(key)) throw new Error(`Unknown configuration field: ${key}.`);
      if (key === 'buildDsh' ? typeof value !== 'boolean' : !['string', 'number'].includes(typeof value)) throw new Error(`Invalid configuration field: ${key}.`);
      if (key !== 'buildDsh') config[key] = String(value);
    }
    resolvePaths(config, dirname(path));
  }
  const overrides = resolvePaths(Object.fromEntries(Object.entries(fields)
    .filter(([flag]) => values[flag] !== undefined).map(([flag, key]) => [key, values[flag]])), cwd);
  const options = {
    stateDir: join(root, '.runtime/controller'), workspace: cwd,
    codex: env.AGENT_HOST_CODEX ?? env.AGENT_REMOTE_CODEX_EXECUTABLE ?? 'codex',
    claude: env.AGENT_HOST_CLAUDE ?? 'claude',
    codexHome: env.AGENT_REMOTE_CODEX_HOME, claudeHome: env.AGENT_HOST_CLAUDE_HOME,
    webPort: 6175, relayPort: 5910, dshPort: 3081,
    registry: 'https://mirrors.cloud.tencent.com/npm/', name: 'Remote Controller', buildDsh: false,
    ...config, ...overrides,
  };
  resolvePaths(options, cwd);
  options.dshHome ??= join(options.stateDir, 'dsh/home');
  for (const key of ['webPort', 'relayPort', 'dshPort']) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 65535) throw new Error(`${key} must be an integer from 1 to 65535.`);
  }
  if (new Set([options.webPort, options.relayPort, options.dshPort]).size !== 3) throw new Error('Web, Relay, and DSH require distinct ports.');
  if (options.dsh && options.dshRepo) throw new Error('Choose either --dsh or --dsh-repo.');
  if (options.buildDsh && !options.dshRepo) throw new Error('--build-dsh requires --dsh-repo.');
  for (const key of [...paths, ...executables, 'name']) {
    if (options[key] !== undefined && !options[key].trim()) throw new Error(`${key} must not be empty.`);
  }
  const registry = new URL(options.registry);
  if (!['http:', 'https:'].includes(registry.protocol) || registry.username || registry.password || registry.search || registry.hash) throw new Error('Registry must be an HTTP(S) URL without credentials, query, or fragment.');
  options.registry = registry.href;
  options.consoleUrl = `http://127.0.0.1:${options.webPort}`;
  options.serverUrl = `http://127.0.0.1:${options.relayPort}`;
  return options;
}

export async function executablePath(name, env = process.env) {
  const candidates = isAbsolute(name) ? [name] : (env.PATH ?? '').split(delimiter).map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return resolve(candidate); } catch {}
  }
  throw new Error(`Executable not found: ${name}. Install it or provide its explicit path; use --help for options.`);
}

export async function assertFreePort(port) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Choose another port; existing services will not be stopped.`)));
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
