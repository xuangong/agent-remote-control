import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { getSessionInfo, getSessionMessages, query, resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { Channel, deadline } from '../channel.ts';

// This worker is launched inside the test's sandbox with an environment allowlist.
const [mode, witnessPath] = process.argv.slice(2);
const witness = JSON.parse(await readFile(witnessPath, 'utf8'));
const started = Date.now();
const report = { mode, workerPid: process.pid, workerGeneration: randomUUID(), events: [], pushes: 0, permissionRequests: 0, children: [] };
const children = new Set();
const emit = (kind, value) => process.stdout.write(`${JSON.stringify({ kind, value })}\n`);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let native, input, pump, nativeChild;

function ownedChild(command, args, options = {}) {
  const child = spawn(command, args, { cwd: witness.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const entry = { generation: randomUUID(), pid: child.pid, command, args, startedMs: Date.now() - started };
  report.children.push(entry);
  children.add(child);
  child.observedExit = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      Object.assign(entry, { code, signal, exitedMs: Date.now() - started });
      children.delete(child); resolve();
    });
    child.once('error', error => {
      entry.error = error.message;
      if (!child.pid) { children.delete(child); resolve(); }
    });
  });
  child.stderr.on('data', chunk => { entry.stderr = ((entry.stderr ?? '') + chunk).slice(-4000); });
  emit('child', { generation: entry.generation, pid: child.pid });
  return child;
}

async function inspectSettings() {
  const settings = await deadline(resolveSettings({ cwd: witness.cwd, settingSources: [] }), 10000, 'managed settings');
  const keys = Object.keys(settings.effective).sort();
  const findings = { keys, digest: digest(settings.effective), sources: settings.sources.map(source => ({
    source: source.source, policyOrigin: source.policyOrigin, keys: Object.keys(source.settings).sort(),
  })) };
  // Any policy-bearing setting needs review; this fixture never overrides it to pass.
  findings.available = keys.length === 0;
  report.settings = findings;
  return findings;
}

async function crash() {
  if (!nativeChild) throw new Error('No owned native process to crash.');
  if (!children.has(nativeChild)) throw new Error('Native exited before the requested crash cut.');
  report.crashRequestedMs = Date.now() - started;
  nativeChild.kill('SIGKILL');
  await deadline(nativeChild.observedExit, 10000, 'owned native crash exit');
  report.crashObserved = true;
}

async function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  await deadline(Promise.all([...children].map(child => child.observedExit)), 10000, 'owned child cleanup');
  input?.close();
  native?.close();
  if (pump) await deadline(pump, 10000, 'SDK iterator cleanup');
  report.remainingChildren = [...children].map(child => child.pid);
}

async function startQuery(resume) {
  const policy = await inspectSettings();
  if (!policy.available || policy.digest !== witness.settingsDigest) throw new Error('Managed settings unavailable or changed; native launch withheld.');
  input = new Channel();
  const target = mode === 'negative' ? witness.nonexistentId : witness.candidateId;
  report.targetId = target;
  if (resume && witness.roleCommittedTo !== witness.candidateId) throw new Error('Missing durable committed role.');
  report.identityOptions = resume ? { resume: target } : { sessionId: target };
  report.configDigest = digest(witness.config);
  if (report.configDigest !== witness.configDigest) throw new Error('Configuration witness digest differs.');
  native = query({ prompt: input, options: {
    ...witness.config, ...report.identityOptions, cwd: witness.cwd,
    pathToClaudeCodeExecutable: witness.executable, env: process.env,
    canUseTool: async () => { report.permissionRequests++; return { behavior: 'deny', message: 'No tools are authorized in this isolated fixture.' }; },
    spawnClaudeCodeProcess(options) {
      const env = { ...process.env };
      for (const [name, value] of Object.entries(options.env)) {
        if (name.startsWith('CLAUDE_AGENT_SDK_') || name === 'CLAUDE_CODE_ENTRYPOINT') env[name] = value;
      }
      nativeChild = ownedChild(options.command, options.args, { env });
      return nativeChild;
    },
  } });
  pump = (async () => {
    for await (const event of native) {
      if (report.events.length >= 64) throw new Error('Public iterator evidence exceeded 64 events.');
      report.events.push(Object.fromEntries(['type', 'subtype', 'session_id', 'uuid', 'user_message_uuid', 'state', 'is_error', 'errors']
        .filter(key => event[key] !== undefined).map(key => [key, event[key]])));
    }
  })().catch(error => { report.streamError = error.message; });
  try {
    const result = await deadline(native.initializationResult(), 10000, 'public initialization');
    report.initialization = { outcome: 'resolved', keys: Object.keys(result),
      sessionId: result.session_id, hooksApplied: result.hooks_applied,
      observedUndeclaredState: result.session_state };
  } catch (error) { report.initialization = { outcome: 'unresolved-or-rejected', error: error.message }; }
  await Promise.race([pause(1000), nativeChild.observedExit]);
  emit('initialized', { ...report, nativeAlive: children.has(nativeChild) });
}

async function run() {
  if (mode === 'preflight') {
    const settings = await inspectSettings();
    if (!settings.available) return;
    report.executable = await realpath(witness.executable);
    const packageJson = new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url);
    report.sdkVersion = JSON.parse(await readFile(packageJson, 'utf8')).version;
    const version = ownedChild(report.executable, ['--version']);
    let stdout = '';
    version.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1000); });
    await deadline(version.observedExit, 10000, 'native version exit');
    report.nativeVersion = stdout.trim();
    const response = await fetch(process.env.ANTHROPIC_BASE_URL, { signal: AbortSignal.timeout(1000) });
    let externalDenied = false;
    try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(800) }); } catch { externalDenied = true; }
    let realHomeDenied = false;
    try { await readdir(witness.deniedHome); } catch (error) { realHomeDenied = error.code === 'EPERM' || error.code === 'EACCES'; }
    report.isolation = { loopbackStatus: response.status, externalDenied, realHomeDenied };
  } else if (mode === 'history') {
    report.candidateId = witness.candidateId;
    report.roleCommittedTo = witness.roleCommittedTo;
    report.inputWitness = witness.input;
    const options = { dir: witness.cwd, includeSystemMessages: true, limit: 64 };
    report.info = await deadline(getSessionInfo(witness.candidateId, { dir: witness.cwd }), 10000, 'public session info');
    report.messages = await deadline(getSessionMessages(witness.candidateId, options), 10000, 'public exact-ID history');
    if (report.messages.length === 64) throw new Error('History reached its bounded page limit.');
  } else {
    const commands = createInterface({ input: process.stdin });
    const control = new Channel();
    commands.on('line', line => control.push(line));
    try {
      await startQuery(mode === 'resume' || mode === 'negative');
      if (mode === 'resume' || mode === 'negative') return;
      if (report.initialization.outcome !== 'resolved') throw new Error('Candidate did not initialize.');
      for await (const command of control) {
        if (command === 'crash') { await crash(); break; }
        if (command !== 'dispatch' || mode !== 'lost-ack' || report.pushes) throw new Error('Unexpected or duplicate probe command.');
        const saved = JSON.parse(await readFile(witnessPath, 'utf8'));
        if (saved.roleCommittedTo !== witness.candidateId || saved.input.recipient !== witness.candidateId || saved.input.phase !== 'dispatch-intended') throw new Error('Input witness does not bind the committed recipient.');
        if (saved.input.contextId !== saved.pendingContext.id || saved.input.contextDigest !== digest(saved.pendingContext)) throw new Error('Input witness does not bind the pending context.');
        if (digest(saved.input.content) !== saved.input.contentDigest) throw new Error('Input witness content changed.');
        input.push({ type: 'user', uuid: saved.input.uuid, session_id: saved.input.recipient, parent_tool_use_id: null,
          message: { role: 'user', content: saved.input.content } });
        report.pushes++;
        emit('pushed', { uuid: saved.input.uuid });
        // Volatile stream receipts are diagnostics only; reconciliation uses fresh public history.
      }
    } finally { commands.close(); control.close(); }
  }
}

process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(1)); });
try { await run(); } catch (error) { report.error = error.message; }
finally {
  try { await cleanup(); } catch (error) { report.cleanupError = error.message; }
  report.elapsedMs = Date.now() - started;
  emit('done', report);
}
