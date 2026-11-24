// Behaviour scenarios of bots (bots design 11): real Claude Code or Codex sessions on this checkout's local instance, driven as the
// person drives them, judged by facts the Relay and the sessions record, never by the wording of a reply.
// Usage, from the checkout root, with the instance running (`pnpm local up`):
//   pnpm test:bots [claude|codex] [scenario ...]        scenarios: temporary, standing, shared, bundle, repository, board, ask, copilot (default: all, in order)
// It creates its own sessions in the instance workspace and its own group, and leaves them for reading in the page.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const command = join(process.cwd(), 'scripts/local/command.mjs');
const [provider = 'claude', ...wanted] = process.argv.slice(2);
if (!['claude', 'codex'].includes(provider)) throw new Error('Give claude or codex.');
const TURN_MS = 8 * 60_000;

/** The instance's Controller command line; its session and api calls never sign in, so they may be polled. */
function controller(...args) {
  try { return JSON.parse(execFileSync(process.execPath, [command, 'controller', ...args], { encoding: 'utf8', timeout: 180_000 })); }
  catch (error) {
    let code;
    try { code = JSON.parse(error.stdout).error?.code; } catch { code = undefined; }
    throw Object.assign(new Error(`controller ${args.slice(0, 3).join(' ')} failed: ${error.stdout || error.stderr || error.message}`), { code });
  }
}
const api = (method, path, body) => controller('api', method, path, ...(body ? ['--body', JSON.stringify(body)] : []));
const status = JSON.parse(execFileSync(process.execPath, [command, 'status', '--json'], { encoding: 'utf8' }));
if (status.state !== 'running') throw new Error('Start the instance first: pnpm local up');
const workspace = join(status.stateDirectory ?? status.directory, 'workspace');
const hostId = api('GET', '/v1/remote/hosts').hosts.find(host => host.online)?.id ?? (() => { throw new Error('The instance has no online Host.'); })();

const results = [];
let approvals = 0;
/** The person allows what a bot asks to do in the workspace, once each; a question for the person ends the run. */
function approve(address) {
  for (const request of controller('session', 'inspect', address).pendingInteractions ?? []) {
    if (request.kind !== 'tool_approval') throw new Error(`${address} asks the person: ${JSON.stringify(request).slice(0, 300)}`);
    controller('session', 'answer', address, request.requestId, '--response', JSON.stringify({ kind: 'tool_approval', decision: 'allow', scope: 'once' }));
    approvals++;
  }
}
function check(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); }

/** Waits until a session has no turn running and its newest entry is newer than `after`; a session waiting on the person fails. */
async function settled(address, after, timeoutMs = TURN_MS) {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  for (;;) {
    const read = await Promise.resolve().then(() => controller('session', 'read', address, '--limit', '1'))
      .catch(error => { if (error.code === 'history_unavailable' && Date.now() < deadline) return {}; throw error; });
    const [newest] = read.entries ?? [], state = read.session?.state;
    if (state === 'waiting') { approve(address); await delay(2000); continue; }
    approveAll();
    // Bots keep working between turns: the session counts as settled once it stayed idle for a while.
    quiet = newest && newest.id !== after && state !== 'running' ? quiet + 1 : 0;
    if (quiet >= 4) return newest;
    if (Date.now() > deadline) throw new Error(`${address} did not settle in ${timeoutMs / 60_000} minutes (state ${state}).`);
    await delay(3000);
  }
}
/** The person answers what any of the scenario's sessions asks: on this instance every session is one the scenario started. */
function approveAll() {
  for (const session of controller('session', 'list', '--limit', '50').sessions ?? []) if (session.state === 'waiting') approve(session.address);
}
/** Waits for a fact to hold, reading it again every few seconds. */
async function until(what, read, timeoutMs = TURN_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    approveAll();
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(5000);
  }
}
const newest = address => controller('session', 'read', address, '--limit', '1').entries?.[0]?.id;
async function say(address, text) { const before = newest(address); controller('session', 'send', address, text); return settled(address, before); }
async function bot(name, mission, providerId = provider) {
  const address = controller('session', 'create', '--provider', providerId, '--message', `Your name is ${name}. Reply with the word READY and nothing else.`).session.address;
  await settled(address, undefined, 4 * 60_000);
  const [, , nativeSessionId] = address.split('/');
  return { name, address, nativeSessionId, providerId, ...(mission ? { mission } : {}) };
}
/** One group of the account with these sessions as its bots, as the page makes it. */
function group(title, bots) {
  const binding = item => ({ hostId, providerId: item.providerId ?? provider, nativeSessionId: item.nativeSessionId, title: item.name });
  // As `createWindowView` makes a primary view.
  const views = bots.map((item, index) => ({ id: `v${index}`, binding: binding(item), placement: 'primary', width: 440, collapsed: false, display: { mode: 'preview', lettersVisible: true } }));
  return api('POST', '/v1/windows', { operationId: randomUUID(), issuedAt: Date.now(), window: { schemaVersion: 3, id: randomUUID(), title, revision: 0,
    selectedPrimaryViewId: 'v0', selectedViewId: 'v0', views }, bots: { rank: 'm', members: Object.fromEntries(bots.map((item, index) => [`v${index}`, { name: item.name, ...(item.mission ? { mission: item.mission } : {}) }])) } });
}
const teams = () => api('GET', '/v1/remote/teams').teams;
/** Whether a session's history holds an input with this text; the Relay forgets messages once delivered, the session does not. */
const received = (address, text) => (controller('session', 'read', address, '--search', text, '--limit', '1').entries ?? []).length > 0;
const chains = () => api('GET', '/v1/remote/chains');
const tasksOf = owner => teams().filter(team => team.task && team.members[1]?.nativeSessionId === owner.nativeSessionId);
const inboxNamed = name => teams().find(team => team.inbox && team.members[0]?.name === name);
const run = name => !wanted.length || wanted.includes(name);
const file = name => join(workspace, name);
const tag = randomUUID().slice(0, 6);

const CHIEF = 'You are the person\'s chief of staff: you run their work with bots, your staff: split each request between temporary bots, or standing bots for roles that recur, and sum up their results for the person.';
/** A bot in a group of its own, once it has read its standing instructions. */
async function chiefBot(name) {
  const created = await bot(name, CHIEF), before = newest(created.address);
  group(`Scenarios ${name}`, [created]);
  await until(`${name}'s standing instructions`, () => teams().find(team => team.inbox && team.members[0]?.nativeSessionId === created.nativeSessionId && team.inbox.instructions), 2 * 60_000);
  await settled(created.address, before);
  return created;
}
const chief = await chiefBot(`Chief ${tag}`);

if (run('temporary')) {
  // An chief splits the person's request between temporary bots, which report back; it sums up for the person.
  const [a, b] = [`alpha-${tag}.txt`, `beta-${tag}.txt`];
  await say(chief.address, `Use two temporary bots working in parallel: one creates ${a} containing the word alpha, the other creates ${b} containing the word beta, both in your working directory. When both have reported, tell me in one line what each did.`);
  const done = await until('both temporary bots to report', () => { const own = tasksOf(chief); return own.length >= 2 && own.every(team => ['done', 'failed'].includes(team.task.state)) && own; });
  check('temporary: the chief started two temporary bots', done.length === 2, `${done.length} started`);
  check('temporary: both reported done', done.every(team => team.task.state === 'done'), done.map(team => team.task.state).join(', '));
  check('temporary: both files exist', existsSync(file(a)) && existsSync(file(b)) && readFileSync(file(a), 'utf8').includes('alpha') && readFileSync(file(b), 'utf8').includes('beta'));
  // Its summary may have come with the reply already; the latest entry once it is quiet is what the person reads.
  const final = await settled(chief.address, undefined);
  check('temporary: the chief summed up for the person', /alpha|beta|\.txt/i.test(final.text ?? ''), (final.text ?? '').slice(0, 120));
  const view = chains(), chain = view.chains.find(item => item.bot && view.names[item.bot] === chief.name && item.cause === 'person' && item.created >= 2);
  check('temporary: one chain from the person\'s input holds both bots', !!chain, chain ? `created ${chain.created}, messages ${chain.messages}, turns ${chain.turns}, tokens ${chain.usage.tokens}` : 'none');
}

let reviewer;
if (run('standing') || run('shared') || run('bundle') || run('repository') || run('ask')) {
  // An chief creates a standing bot with a mission; it reports in, works with the chief by message, takes the person's
  // lasting change into its own mission, and keeps a board item to its end.
  const target = `review-${tag}.txt`;
  execFileSync('/bin/sh', ['-c', `printf 'The release ships on Friday.\\n' > '${file(target)}'`]);
  await say(chief.address, `Create a standing bot named Reviewer ${tag} whose mission is to review text files in this working directory when a bot or the person asks, and to answer in one line. Then ask it to review ${target}.`);
  const inbox = await until('the standing reviewer', () => inboxNamed(`Reviewer ${tag}`));
  check('standing: the chief created a standing reviewer', !!inbox.inbox.botId && !inbox.inbox.pending, inbox.inbox.botId);
  reviewer = { name: `Reviewer ${tag}`, nativeSessionId: inbox.members[0].nativeSessionId, address: `${hostId}/${inbox.members[0].providerId}/${inbox.members[0].nativeSessionId}` };
  await settled(reviewer.address, undefined);
  const answered = await until('the reviewer\'s answer to its chief', () => received(chief.address, `[Message from Reviewer ${tag}`)).catch(() => false);
  check('standing: the reviewer answered its chief by message', answered);
  if (run('standing')) {
    await say(reviewer.address, 'From now on, also give the number of words of every file you review.');
    const mission = await until('the reviewer to record its mission', () => {
      const window = api('GET', '/v1/windows').groups?.find(item => Object.values(item.bots?.members ?? {}).some(member => member.name === reviewer.name));
      const member = window && Object.values(window.bots.members).find(item => item.name === reviewer.name);
      return member?.mission && /word/i.test(member.mission) && member.mission;
    }, 4 * 60_000).catch(() => undefined);
    check('standing: the person\'s lasting change is in the reviewer\'s mission', !!mission, (mission ?? '').slice(0, 120));
    await say(reviewer.address, `Put an item for reviewing ${target} again with the word count on your board, do the review, then mark the item done with its result.`);
    const item = await until('a finished board item', () => inboxNamed(reviewer.name)?.inbox?.board?.items.find(entry => entry.status === 'done'), 4 * 60_000).catch(() => undefined);
    check('standing: the reviewer kept a board item to its end', !!item, item?.result ?? 'none');
  }
}

if (run('shared') && reviewer) {
  // A second chief asks the same reviewer: it serves both teams, and each answer reaches the one who asked.
  const second = await chiefBot(`Planner ${tag}`);
  await say(second.address, `Ask the bot ${reviewer.name} to review review-${tag}.txt and tell me its answer.`);
  const answered = await until('the reviewer\'s answer to the second chief', () => received(second.address, `[Message from ${reviewer.name}`)).catch(() => false);
  check('shared: the reviewer answered a second chief', answered);
}

if (run('bundle') && reviewer) {
  // Code moves as a git bundle attached to a message when no repository is shared: the chief bundles a branch, the reviewer
  // downloads the verified file and reads the branch, and answers. On one machine the chief is told to use the bundle.
  const repo = file(`repo-${tag}`), started = Date.now();
  execFileSync('/bin/sh', ['-c', `git init -q '${repo}' && cd '${repo}' && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base`]);
  await say(chief.address, `In repo-${tag} (a git repository in your working directory), create a branch named change-${tag} with one commit adding change.txt containing the word bundled. Make a git bundle of that branch and send it to ${reviewer.name} as an attachment of a message, asking it to check that the branch adds change.txt and to answer you. Do not share the repository path; the bundle is how it gets the change.`);
  const attached = await until('the bundle to reach the reviewer', () => received(reviewer.address, 'sha256'), 6 * 60_000).catch(() => false);
  check('bundle: the chief attached a file to its message', attached);
  const downloaded = await until('the reviewer to download the bundle', () => {
    // The Controller saves under its temporary directory: on macOS the per-user one, whatever this shell's TMPDIR says.
    const userTemp = (() => { try { return execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim(); } catch { return undefined; } })();
    const roots = [...new Set([tmpdir(), userTemp, '/tmp'].filter(Boolean))].map(root => join(root, 'agent-remote-attachments')).filter(existsSync);
    return roots.flatMap(root => readdirSync(root, { recursive: true }).map(name => join(root, String(name))))
      .find(path => statSync(path).isFile() && statSync(path).mtimeMs >= started);
  }, 6 * 60_000).catch(() => undefined);
  check('bundle: the reviewer downloaded the verified file', !!downloaded, downloaded ?? 'none');
  const answered = await until('the reviewer to answer about the bundle', () => received(chief.address, 'change.txt') && received(chief.address, `[Message from ${reviewer.name}`), 6 * 60_000).catch(() => false);
  check('bundle: the reviewer answered the chief about the change', answered);
}

if (run('repository') && reviewer) {
  // Code moves through a repository both bots reach, the first way the base instructions name: the chief pushes a branch and
  // says where it is in a message without a file; the reviewer fetches it and answers. A bare repository stands for the remote.
  const remote = file(`remote-${tag}.git`), repo = file(`shared-${tag}`), branch = `shared-${tag}`;
  execFileSync('/bin/sh', ['-c', `git init -q --bare '${remote}' && git init -q '${repo}' && cd '${repo}' && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m base && git remote add origin '${remote}' && git push -q origin HEAD:main`]);
  await say(chief.address, `In shared-${tag} (a git repository in your working directory whose remote "origin" is shared with other bots), create a branch named ${branch} with one commit adding shared.txt containing the word shared, push it to origin, then message ${reviewer.name}: give it the remote ${remote} and the branch, and ask it to fetch the branch, check that it adds shared.txt, and answer you. Attach no file.`);
  const pushed = await until('the branch on the shared remote', () => { try { return execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`], { encoding: 'utf8' }).trim(); } catch { return undefined; } }, 6 * 60_000).catch(() => undefined);
  check('repository: the chief pushed its branch to the shared remote', !!pushed, pushed ?? 'none');
  const told = await until('the reviewer to hear where the branch is', () => received(reviewer.address, branch), 6 * 60_000).catch(() => false);
  check('repository: the chief told the reviewer the remote and branch by message', told);
  const answered = await until('the reviewer to answer about the branch', () => received(chief.address, 'shared.txt') && received(chief.address, `[Message from ${reviewer.name}`), 8 * 60_000).catch(() => false);
  check('repository: the reviewer fetched the branch and answered the chief', answered);
  // An attached file is listed with its sha256 after the sender's words: the input that named the branch carries none.
  const named = controller('session', 'read', reviewer.address, '--search', branch, '--limit', '10').entries ?? [];
  check('repository: no file was attached, since the repository is shared', named.length > 0 && named.every(entry => !(entry.text ?? '').includes('sha256')));
}

if (run('board')) {
  // The chief keeps its plan on its board: it gives an item to a temporary bot, which finishes it and fills it in; a lasting fact goes
  // to its memory.
  const out = `gamma-${tag}.txt`;
  await say(chief.address, `Put an item "Write ${out}" on your board and give it to a temporary bot, naming the item when you create the bot: it creates ${out} containing the word gamma in your working directory. When it has finished, make sure the item is done with the file as its result.`);
  const item = await until('the board item to be done', () => inboxNamed(chief.name)?.inbox?.board?.items?.find(entry => entry.title.includes(out) && entry.status === 'done'), 8 * 60_000).catch(() => undefined);
  check('board: the chief\'s item is done', !!item, item ? `${item.status} · ${item.result ?? item.latestReport ?? ''}`.slice(0, 120) : 'none');
  const worker = item ? tasksOf(chief).find(team => team.task.botId === item.assignee) : undefined;
  check('board: the item was given to a temporary bot', !!worker, worker ? ` · ` : item?.assignee ?? 'none');
  check('board: the file exists', existsSync(file(out)) && readFileSync(file(out), 'utf8').includes('gamma'));
  await say(chief.address, 'Remember this for every session of yours: releases are approved by Dana.');
  const fact = await until('the fact in the chief\'s memory', () => {
    const member = api('GET', '/v1/windows').groups?.flatMap(group => Object.values(group.bots?.members ?? {})).find(entry => entry.name === chief.name);
    return member?.memory?.find(entry => /Dana/.test(entry.text));
  }, 4 * 60_000).catch(() => undefined);
  check('board: the chief kept the lasting fact in its memory', !!fact, fact?.text ?? 'none');
}

if (run('ask') && reviewer) {
  // The person mentions the reviewer from the chief's conversation while the reviewer is busy: an answer session answers at once, the
  // chief's session receives nothing, and the reviewer's main session never sees the question.
  controller('session', 'send', reviewer.address, `Count slowly from 1 to 40, one number per line, and then say "counted".`);
  const question = `What is 6 times 7 (${tag})? Answer with the number only.`;
  api('POST', '/v1/remote/teams/ask', { operationId: randomUUID(), source: { hostId, providerId: provider, nativeSessionId: chief.nativeSessionId, title: chief.name }, bot: reviewer.name, text: question });
  const answer = await until('the answer to the mention', () => teams().find(team => team.ask && team.ask.from.nativeSessionId === chief.nativeSessionId && team.ask.entries.some(entry => entry.text === question && entry.answer))
    ?.ask.entries.find(entry => entry.text === question).answer, 6 * 60_000).catch(() => undefined);
  check('ask: the mention was answered', !!answer && /42/.test(answer.text), answer?.text?.slice(0, 80) ?? 'none');
  check('ask: the chief\'s session received nothing', !received(chief.address, `6 times 7 (${tag})`));
  check('ask: the reviewer\'s main session never saw the question', !received(reviewer.address, `6 times 7 (${tag})`));
  await settled(reviewer.address, undefined).catch(() => undefined);
}

if (run('copilot')) {
  // A bot on another provider is asked a question and answers: by message, or with its final text when it sends none.
  const helper = await bot(`Helper ${tag}`, 'You answer questions from bots or the person in one short line.', 'copilot');
  const before = newest(helper.address);
  group(`Scenarios Helper ${tag}`, [helper]);
  await until(`${helper.name}'s standing instructions`, () => teams().find(team => team.inbox && team.members[0]?.nativeSessionId === helper.nativeSessionId && team.inbox.instructions), 3 * 60_000);
  await settled(helper.address, before).catch(() => undefined);
  await say(chief.address, `Ask the bot ${helper.name} what 17 times 3 is, and tell me its answer.`);
  const answered = await until('the Copilot bot to answer', () => received(chief.address, `${helper.name}`) && received(chief.address, '51') && received(chief.address, `[Message from ${helper.name}`), 6 * 60_000).catch(() => false);
  check('copilot: a Copilot bot answered a question from the chief', answered);
}

const failed = results.filter(item => !item.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed with ${provider}; the person answered ${approvals} approvals.`);
process.exitCode = failed.length ? 1 : 0;
