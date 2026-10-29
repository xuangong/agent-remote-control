import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAgentProvider } from '@orchardworks/agent-provider-claude';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { nativeFixture, nativeReply } from '../../agent-provider-claude/src/test-utils/native-fixture.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../../agent-provider-claude/dist/catalog.js';
import { TeamBroker } from '../../agent-remote-hosted/src/teams.js';
import type { SavedTeam } from '../../agent-remote-hosted/src/team-delivery.js';
import { emptyCallForSupportState, executeProfileCommand, setEnablement } from '../../agent-remote-hosted/src/call-for-support-profiles.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import { createCodexHostRegistration } from './codex.js';
import { createAgentHostRuntime } from './host.js';
import { SessionReferenceStore } from './session-reference.js';

const claudeExecutable = process.env.AGENT_CLAUDE_TEST_EXECUTABLE, codexExecutable = process.env.BORGEE_CODEX_TEST_EXECUTABLE;
type Item = Record<string, any>;
const json = (value: unknown) => { if (typeof value !== 'string') return undefined; try { return JSON.parse(value); } catch { return undefined; } };
/** A tool result's JSON, however the provider wrapped it. */
const resultJson = (value: unknown): any => {
  if (typeof value === 'string') return json(value);
  if (Array.isArray(value)) return json(value.map(part => part?.text ?? '').join(''));
  return undefined;
};
const textOf = (item: Item) => typeof item.content === 'string' ? item.content : (item.content ?? []).map((part: Item) => part.text ?? '').join('\n');
const supporterNames = ['Claude reviewer', 'Codex reviewer', 'Fixer'];

it.runIf(!!claudeExecutable && !!codexExecutable)('a Codex worker calls for a cross review: read-only supporters on two providers report, a fixer\'s patch applies, and a follow-up reuses the supporters', async () => {
  // The worker's repository.
  const f = await nativeFixture((body, response) => claudeReviewer(body, response));
  const repo = f.cwd;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); await writeFile(join(repo, 'login.ts'), 'export const login = (input: string) => input;\n'); git('add', '.'); git('commit', '-qm', 'login');
  const commit = git('rev-parse', 'HEAD');
  let profileId = '';

  // Claude: the reviewer tries to write the workspace, reads its Team and reports to the coordinator.
  function claudeReviewer(body: any, response: Parameters<typeof nativeReply>[0]) {
    const messages: Item[] = body.messages ?? [];
    const start = messages.findLastIndex(message => message.role === 'user' && textOf(message).includes('[Team '));
    const results = messages.slice(start + 1).flatMap(message => Array.isArray(message.content) ? message.content.filter((part: Item) => part.type === 'tool_result') : []);
    const tool = (name: string) => body.tools?.find((item: Item) => item.name.endsWith(`__${name}`))?.name ?? `mcp__agent_host__${name}`;
    const brief = start >= 0 ? textOf(messages[start]!) : '';
    if (!brief) return nativeReply(response, [{ type: 'text', text: 'IDLE' }]);
    if (results.length === 0) return nativeReply(response, [{ type: 'tool_use', id: `write-${randomUUID()}`, name: 'Bash', input: { command: 'echo hacked > hacked-claude.txt; echo exit=$?', description: 'Try to write' } }]);
    if (results.length === 1) return nativeReply(response, [{ type: 'tool_use', id: `team-${randomUUID()}`, name: tool('read_team'), input: {} }]);
    if (results.length === 2) {
      const team = resultJson(results[1]!.content) ?? resultJson((results[1]!.content as Item[] | undefined)?.map?.((part: Item) => ({ text: part.text })));
      const leader = team?.members?.find((member: Item) => member.role === 'leader')?.id;
      return nativeReply(response, [{ type: 'tool_use', id: `send-${randomUUID()}`, name: tool('send_team_message'),
        input: { to: leader, operationId: `claude-${brief.includes('RE-REVIEW') ? 'second' : 'first'}`, text: `Claude reviewer: ${brief.includes('RE-REVIEW') ? 'the fix holds' : 'input is unchecked'}; the workspace refused my write.` } }]);
    }
    return nativeReply(response, [{ type: 'text', text: 'CLAUDE_REVIEWED' }]);
  }

  // Codex: one fixture model for the worker, the coordinator and the Codex supporters, told apart by their instructions.
  const codexHome = join(f.home, 'codex'); await mkdir(codexHome);
  const codexLog: unknown[] = [], urls: string[] = [];
  const codexServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      urls.push(`${new Date().toISOString()} ${request.method} ${request.url}`);
      if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const item = codexStep(body);
      codexLog.push({ kind: JSON.stringify(body).includes('You coordinate Call For Support') ? 'coordinator' : JSON.stringify(body).includes('You support the role') ? 'supporter' : 'worker',
        last: (body.input ?? []).slice(-2).map((entry: Item) => JSON.stringify(entry).slice(0, 300)), item: JSON.stringify(item).slice(0, 300) });
      const id = `r-${randomUUID()}`;
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  codexServer.listen(0, '127.0.0.1'); await once(codexServer, 'listening');
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.5"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[features]\nplugins = false\n`
    + `[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${(codexServer.address() as { port: number }).port}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const message = (text: string) => ({ type: 'message', role: 'assistant', id: `m-${randomUUID()}`, content: [{ type: 'output_text', text }] });
  const call = (name: string, args: unknown, namespace?: string) => ({ type: 'function_call', call_id: `c-${randomUUID()}`, name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) });
  function codexStep(body: any): Item {
    const input: Item[] = body.input ?? [], all = JSON.stringify(input);
    // Steps follow from the whole conversation, because messages may arrive into a running turn.
    const calls = (name: string, marker?: string) => input.filter(item => item.type === 'function_call' && item.name === name && (!marker || String(item.arguments).includes(marker)));
    const output = (name: string, marker?: string) => { const last = calls(name, marker).at(-1); return last ? resultJson(input.find(item => item.type === 'function_call_output' && item.call_id === last.call_id)?.output) : undefined; };
    const state = { input, all, calls, output }, instructions = JSON.stringify(body.instructions ?? '') + all;
    if (instructions.includes('You coordinate Call For Support')) return coordinator(state);
    if (instructions.includes('You support the role')) return supporter(state);
    return worker(state);
  }
  type State = { input: Item[]; all: string; calls(name: string, marker?: string): Item[]; output(name: string, marker?: string): any };
  function worker({ input, all, calls, output }: State): Item {
    const searches = input.filter(item => item.type === 'tool_search_call').length, called = calls('call_for_support', undefined).length;
    const reports = input.filter(item => item.type === 'message' && item.role === 'user' && textOf(item).startsWith('[Support report'));
    const followUp = input.some(item => item.type === 'message' && item.role === 'user' && textOf(item).includes('Follow up'));
    if (!called) return searches ? call('call_for_support', { profileId, task: 'Review the login handling before the pull request.', deliverable: 'findings', context: { commit } }, 'agent_remote')
      : { type: 'tool_search_call', call_id: `s-${randomUUID()}`, execution: 'client', arguments: { query: 'call for support review', limit: 3 } };
    const report = reports[0] ? textOf(reports[0]) : '';
    const resource = /Resource ([^:\s]+):/.exec(report)?.[1];
    if (resource && !calls('download_support_resource').length) return call('download_support_resource', { callId: /call ([0-9a-f]{64}) ·/.exec(report)?.[1], resourceId: resource }, 'agent_remote');
    if (followUp && called < 2) {
      if (searches < 2) return { type: 'tool_search_call', call_id: `s-${randomUUID()}`, execution: 'client', arguments: { query: 'call for support follow up', limit: 3 } };
      const first = output('call_for_support', profileId);
      return call('call_for_support', { roleId: first.roleId, followUpOf: first.callId, task: 'Follow up: re-review after the fix.', deliverable: 'findings', context: { commit } }, 'agent_remote');
    }
    return message(all.includes('the fix holds') ? 'GOT_SECOND_REPORT' : reports.length ? 'GOT_REPORT' : 'CALLED');
  }
  function coordinator({ all, calls, output }: State): Item {
    const replies = (name: string) => all.split(`${name}: `).length - 1;
    const callIds = [...new Set([...all.matchAll(/\[Support call ([0-9a-f]{64}) ·/g)].map(match => match[1]!))];
    const id = (name: string) => ((output('read_team')?.members ?? []) as Item[]).find(member => member.name === name)?.id;
    if (!callIds.length) return message('IDLE');
    if (!calls('propose_roster').length) return call('propose_roster', { operationId: 'roster-1', rationale: 'Two independent providers and a fixer.', members: [
      { name: 'Claude reviewer', responsibility: 'Review.', providerId: 'claude', model: 'claude-sonnet-4-5-20250929', workspace: 'shared' },
      { name: 'Codex reviewer', responsibility: 'Review.', providerId: 'codex', model: 'gpt-5.5', workspace: 'shared' },
      { name: 'Fixer', responsibility: 'Fix.', providerId: 'codex', model: 'gpt-5.5', workspace: 'worktree' }] });
    if (!calls('read_team').length) return call('read_team', {});
    for (const name of supporterNames) if (!calls('send_team_message', `brief-${name}`).length)
      return call('send_team_message', { to: id(name), operationId: `brief-${name}`, text: name === 'Fixer' ? `FIX at ${commit}: write fix.txt.` : `REVIEW ${commit}: check login.ts.` });
    if (!supporterNames.every(name => replies(name) >= 1)) return message('WAITING');
    if (!calls('collect_supporter_patch').length) return call('collect_supporter_patch', { target: id('Fixer'), operationId: 'patch-1' });
    if (!calls('report_support', 'report-1').length) return call('report_support', { callId: callIds[0], operationId: 'report-1', status: 'reported',
      summary: 'Both reviewers found unchecked input; the fixer\'s patch is attached.', resources: [output('collect_supporter_patch').resource.resourceId],
      findings: [{ id: 'f1', severity: 'major', location: 'login.ts:1', problem: 'Input is unchecked.', suggestion: 'Apply the patch.', agreement: '2 of 2 reviewers' }] });
    if (callIds.length < 2) return message('REPORTED');
    for (const name of supporterNames.slice(0, 2)) if (!calls('send_team_message', `rebrief-${name}`).length)
      return call('send_team_message', { to: id(name), operationId: `rebrief-${name}`, text: `RE-REVIEW ${commit}.` });
    if (replies('Claude reviewer') < 2 || replies('Codex reviewer') < 2) return message('WAITING_AGAIN');
    if (!calls('report_support', 'report-2').length) return call('report_support', { callId: callIds[1], operationId: 'report-2', status: 'reported', summary: 'Both reviewers agree the fix holds.', findings: [] });
    return message('REPORTED_AGAIN');
  }
  function supporter({ all, calls, output }: State): Item {
    const fixing = all.includes('FIX at'), again = all.includes('RE-REVIEW');
    const operation = fixing ? 'fix-first' : again ? 'codex-second' : 'codex-first';
    if (!all.includes('[Team ') || calls('send_team_message', operation).length) return message('SUPPORTED');
    if (!calls('exec_command').length) return call('exec_command', { cmd: fixing ? 'echo fixed > fix.txt; echo exit=$?' : 'echo hacked > hacked-codex.txt; echo exit=$?', max_output_tokens: 200 });
    if (calls('read_team').length < (again ? 2 : 1)) return call('read_team', {});
    const leader = ((output('read_team')?.members ?? []) as Item[]).find(member => member.role === 'leader')?.id;
    return call('send_team_message', { to: leader, operationId: operation,
      text: fixing ? 'Fixer: fix.txt is ready in my worktree.' : `Codex reviewer: ${again ? 'the fix holds' : 'input is unchecked'}.` });
  }

  // The Controller with real Codex and Claude, and an in-process Relay Team broker with Call For Support.
  const codex = await createCodexHostRegistration({ executable: codexExecutable, codexHome, env: { OPENAI_API_KEY: 'local-test', LC_ALL: 'C' }, referenceDirectory: join(f.home, 'codex-references') });
  const claude = new ClaudeAgentProvider({ ...f.options, catalog: createClaudeCatalog(f.options.env, 15000) });
  const support = emptyCallForSupportState();
  let teams: SavedTeam[] = [];
  let host!: ReturnType<typeof createAgentHostRuntime>;
  const resolve = (_host: string, providerId: string, nativeSessionId: string) => host.roleRouting!.resolve({ controllerId: 'host', providerId, nativeSessionId }).target;
  const control = async (path: string, body: unknown, sessionId?: string) => {
    const result = await host.control({ method: 'POST', path, ...(sessionId ? { sessionId } : {}), body: JSON.stringify(body) });
    if (result.status !== 200) throw new Error(result.body); return JSON.parse(result.body);
  };
  const broker = new TeamBroker({ read: () => teams, now: Date.now, assertHost() {}, resolveSession: resolve,
    async change(update) { const draft = structuredClone(teams), value = structuredClone(update(draft)); teams = draft; return value; },
    createSeat: (_host, seat) => control('/remote/team/create-seat', seat),
    callForSupport: { state: () => support, capable: () => true, assertHost() {}, readOnly: () => true,
      supportBundle: (_host, input) => control('/remote/team/support-bundle', input), supportPatch: (_host, input) => control('/remote/team/support-patch', input) },
    resources: new (await import('../../agent-remote-hosted/src/team-resources.js')).PortableTeamResourceStore({ storage: (() => {
      const rows = new Map<string, Uint8Array>();
      return { async get(key: string) { return rows.get(key); }, async put(key: string, value: Uint8Array) { rows.set(key, value); }, async delete(key: string) { rows.delete(key); },
        async list(prefix: string) { return [...rows.keys()].filter(key => key.startsWith(prefix)); } };
    })() }),
  });
  host = createAgentHostRuntime({ succession: { controllerId: 'host', stateDirectory: join(f.home, 'succession'), enrollment: true },
    team: { stateDirectory: join(f.home, 'team'), tickMs: 100, request: call => broker.hostCall('host', call, () => {}, true), genericSuccession: () => true, callForSupport: () => true },
    registrations: [codex, { directory: createClaudeSessionDirectory(claude, [], undefined, new SessionReferenceStore(join(f.home, 'claude-references'), 'claude')), adapter: claude }] });
  profileId = executeProfileCommand(support, { type: 'create', profile: { name: 'Cross review', description: 'Independent reviewers and a fixer.', enableByDefault: false,
    coordinator: { providerId: 'codex', model: 'gpt-5.5' },
    mandate: { supporters: [{ providerId: 'claude', model: 'claude-sonnet-4-5-20250929' }, { providerId: 'codex', model: 'gpt-5.5' }], maxSupporters: 3, workspaces: ['shared', 'worktree'], remoteHosts: [], approval: 'within_mandate' } } }, Date.now())!.id;
  const turns = async (agentId: string, text: string | undefined, count: number) => {
    const agent = host.relay.requireAgent(agentId);
    let ended = 0; const stop = agent.subscribe(update => { if (update.type === 'agent_stream' && update.event.type === 'turn_completed') ended++; });
    try { if (text) await agent.sendMessage(text); await expect.poll(() => ended, { timeout: 90_000, interval: 200 }).toBeGreaterThanOrEqual(count); } finally { stop(); }
  };
  const group = (): Team => structuredClone(teams.find(team => team.callForSupport)!) as Team;
  try {
    // A worker created before it was enabled declares the tools deferred, and finds them by search once enabled.
    const worker = await control('/remote/create', { providerId: 'codex', operationId: randomUUID(), cwd: repo }, randomUUID());
    setEnablement(support, resolve, { hostId: 'host', providerId: 'codex', nativeSessionId: worker.nativeSessionId }, [profileId], Date.now());
    await new Promise(resolve => setTimeout(resolve, 500));
    const workerAgent = host.relay.requireAgent(worker.agentId);
    const workerTurns = { value: 0 }; const stopWorker = workerAgent.subscribe(update => { if (update.type === 'agent_stream' && update.event.type === 'turn_completed') workerTurns.value++; });
    await turns(worker.agentId, 'Implement the feature, then get it reviewed.', 1);
    await expect.poll(() => group()?.callForSupport?.calls[0]?.status, { timeout: 120_000, interval: 250 }).toBe('reported').catch(async error => {
      const coordinator = group().members[0]!;
      const attached = coordinator.nativeSessionId ? await control('/remote/attach', { providerId: coordinator.providerId, nativeSessionId: coordinator.nativeSessionId }, randomUUID()).catch(failure => ({ failure: String(failure) })) : undefined;
      const snapshot = attached && 'agentId' in attached ? host.relay.requireAgent(attached.agentId).snapshot().payload : attached;
      // The group, the Codex requests and the coordinator's state explain where the call stalled.
      throw new Error(`${error instanceof Error ? error.message : error}\n${JSON.stringify({ teams, codexLog, urls, snapshot }).slice(0, 50_000)}`); });
    await expect.poll(() => workerTurns.value, { timeout: 60_000, interval: 250 }).toBeGreaterThanOrEqual(2);
    const first = group();
    expect(first.members.filter(member => member.role === 'member').map(member => [member.name, member.providerId, member.creation, member.access ?? 'writable'])).toEqual([
      ['Claude reviewer', 'claude', 'ready', 'read_only'], ['Codex reviewer', 'codex', 'ready', 'read_only'], ['Fixer', 'codex', 'ready', 'writable']]);
    // Read-only supporters could not write the worker's workspace; the fixer wrote only its own worktree.
    expect(existsSync(join(repo, 'hacked-claude.txt'))).toBe(false);
    expect(existsSync(join(repo, 'hacked-codex.txt'))).toBe(false);
    expect(existsSync(join(repo, 'fix.txt'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
    // The worker downloaded the fixer's patch; it applies to the worker's repository.
    const download = (await import('node:fs/promises')).readdir;
    const downloads = join(codexHome, '..', 'team', 'support-resources', 'downloads');
    const patches = (await download(downloads, { recursive: true })).filter(name => String(name).endsWith('.patch'));
    expect(patches).toHaveLength(1);
    const patch = join(downloads, String(patches[0]));
    expect(await readFile(patch, 'utf8')).toContain('+fixed');
    git('apply', '--check', patch);

    // A follow-up on the same role reaches the same coordinator and the same reviewers.
    const sessions = first.members.map(member => member.nativeSessionId);
    await turns(worker.agentId, 'Follow up after the fix.', 1);
    await expect.poll(() => group().callForSupport!.calls.map(call => call.status), { timeout: 120_000, interval: 250 }).toEqual(['reported', 'reported']);
    expect(group().members.map(member => member.nativeSessionId)).toEqual(sessions);
    expect(group().callForSupport!.calls[1]!.followUpOf).toBe(first.callForSupport!.calls[0]!.id);
    expect(group().callForSupport!.usage.tokens).toBeGreaterThan(0);
    stopWorker();
  } finally { await host.close(); codexServer.close(); await f.close(); }
}, 300_000);
