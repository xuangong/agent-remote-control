import { createServer, request } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const root = process.env.CONTROLLER_FIXTURE_ROOT;
const mode = process.env.CONTROLLER_FIXTURE_MODE;
const record = (event) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify(event) + '\n');
const keep = () => {
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => { record({ stopped: mode }); process.exit(0); });
};
const register = async (body) => {
  const response = await fetch(process.env.AGENT_HOST_SERVER ?? process.env.AGENT_REMOTE_SERVER_URL, {
    method: 'POST', body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Fixture pairing was rejected.');
};

if (mode === 'pnpm') {
  if (args[0] === '--version') console.log('10.34.5');
  else if (args[0] === 'install') { record({ installed: true }); }
  else if (args[0] === 'build') {
    record({ built: true });
    const copilot = join(root, 'packages/agent-provider-copilot/dist/index.js');
    mkdirSync(dirname(copilot), { recursive: true });
    writeFileSync(copilot, `export function resolveCopilotExecutable() { return ${JSON.stringify(join(root, 'bin/copilot'))}; }`);
    const relay = join(root, 'packages/agent-remote-relay/dist/index.js');
    mkdirSync(dirname(relay), { recursive: true }); writeFileSync(relay, '');
    writeFileSync(join(root, 'built'), 'yes');
  } else if (args.includes('tsx')) {
    const keys = new Set(); const hosts = [];
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/remote/pairings') {
        const key = 'arc_fixture-private-' + keys.size; keys.add(key);
        record({ pairing: true }); res.end(JSON.stringify({ key }));
      } else if (req.url === '/v1/remote/hosts') res.end(JSON.stringify({ hosts }));
      else if (req.url === '/' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (!keys.has(body.key)) { res.statusCode = 401; res.end('{}'); return; }
        hosts.push({ id: body.id, name: body.name, online: true, providers: body.providers.map((providerId) => ({ providerId })) });
        record({ registered: body.providers }); res.end('{}');
      } else if (req.url.includes('/workspaces?')) {
        if (new URL(req.url, 'http://fixture').searchParams.has('limit')) { res.statusCode = 400; res.end('{"error":"Unexpected workspace pagination"}'); }
        else res.end(JSON.stringify({ workspaces: [] }));
      }
      else if (req.url.includes('/catalog?')) {
        if (process.env.CONTROLLER_FIXTURE_FAIL_CATALOG === '1') { res.statusCode = 503; res.end('{"error":"catalog unavailable"}'); }
        else res.end(JSON.stringify({ items: [], hasMore: false }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
    setTimeout(() => server.listen(Number(process.env.AGENT_REMOTE_PORT), '127.0.0.1'), 700);
    keep();
  } else if (args.includes('preview')) {
    const port = Number(args[args.indexOf('--port') + 1]);
    createServer((req, res) => {
      if (!req.url.startsWith('/v1/')) { res.end('<html>Built controller</html>'); return; }
      const upstream = request(process.env.VITE_AGENT_REMOTE_RELAY_TARGET + req.url, (response) => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { res.statusCode = 500; res.end('Broker not ready'); }); upstream.end();
    }).listen(port, '127.0.0.1');
    keep();
  }
} else if (mode === 'codex' || mode === 'claude' || mode === 'copilot') {
  record({ version: mode });
  console.log(mode === 'copilot' ? 'GitHub Copilot CLI 1.0.83' : mode === 'codex' ? 'codex-cli 0.148.0' : '2.1.247 (Claude Code)');
} else if (mode === 'host') {
  if (!existsSync(join(root, 'built'))) throw new Error('The Host was not built.');
  await register({ key: process.env.AGENT_HOST_REMOTE_KEY, id: 'native', name: process.env.AGENT_HOST_NAME,
    providers: process.env.AGENT_HOST_PROVIDERS.split(',') });
  record({ copilot: process.env.AGENT_HOST_COPILOT, copilotHome: process.env.AGENT_HOST_COPILOT_HOME, codex: process.env.AGENT_HOST_CODEX, claude: process.env.AGENT_HOST_CLAUDE, workspace: process.env.AGENT_HOST_WORKSPACE });
  keep();
} else if (mode === 'dsh') {
  if (args[0] === '--version') console.log('0.1.2-rc.1');
  else if (args[0] === 'plugin') record({ pluginInstalled: true, home: process.env.DSH_HOME });
  else {
    const port = Number(args[args.indexOf('--port') + 1]);
    createServer((_, response) => response.end('<html>DSH</html>')).listen(port, '127.0.0.1');
    await register({ key: process.env.AGENT_REMOTE_ACCESS_KEY, id: 'dsh', name: process.env.AGENT_REMOTE_INSTANCE_NAME, providers: ['dsh'] });
    console.log('dsh web: http://127.0.0.1:' + port);
    console.log(process.env.AGENT_REMOTE_ACCESS_KEY);
    console.log('Agent Remote uplink registered.');
    keep();
  }
}
