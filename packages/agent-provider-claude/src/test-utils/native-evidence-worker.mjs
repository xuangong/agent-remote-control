import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Channel } from '../channel.ts';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { ClaudeAgentProvider } = await import(pathToFileURL(config.module).href);
const report = { diagnostics: [], exits: [], sourceCalls: 0, nativeFrames: [], normalized: [], stopHooks: [] };
const providers = [];
const options = { executable: config.executable, requestTimeoutMs: 8000,
  query(input) { const native = query({ ...input, options: { ...input.options, hooks: { ...input.options.hooks, Stop: [...(input.options.hooks?.Stop ?? []), { hooks: [async value => { report.stopHooks.push(value); return {}; }] }] } } }); return new Proxy(native, { get(target, key) { if (key === Symbol.asyncIterator) return async function* () { for await (const message of target) { report.nativeFrames.push({ type: message.type, subtype: message.subtype, state: message.state, queued_turn_count: message.queued_turn_count, user_message_uuid: message.user_message_uuid, message: message.message, tasks: message.tasks }); yield message; } }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }); },
  onDiagnostic(line) {
    try { const item = JSON.parse(line); if (item.event === 'native_process_exited') report.exits.push(item); }
    catch { report.diagnostics.push(line.slice(0, 1000)); }
  } };
const provider = () => { const result = new ClaudeAgentProvider(options); providers.push(result); return result; };
let stopping = false;
const waitFor = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) { if (stopping) throw new Error('Evidence worker was stopped.'); const value = await read(); if (value) return value; await pause(30); } throw new Error(`${label} timed out.`); };
const respond = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let error, raw, rawInput, rawPump, rawExit;
process.once('SIGTERM', () => { stopping = true; rawInput?.close(); raw?.close(); for (const instance of providers) void instance.dispose().catch(() => {}); });
try {
  const first = provider();
  const created = await first.nativeEvidence.createEmpty({ sessionId: randomUUID(), cwd: config.cwd });
  if (created.status !== 'created') throw new Error('Empty creation failed');
  report.creation = created;
  try { await first.resumeSession(created.handle); throw new Error('Missing native history unexpectedly resumed'); }
  catch (failure) { if (!failure.message.includes('unavailable')) throw failure; report.defaultResumeRejected = true; }
  const empty = await first.resumeSession(created.handle, {}, { initializeEmpty: true });
  report.initialReadiness = await empty.nativeEvidence.inspectReadiness();
  await empty.setSessionSetting('model', 'sonnet');
  const effort = (await empty.runtimeInfo()).settings.find(setting => setting.id === 'reasoning_effort');
  if (effort?.options.some(option => option.value === 'high')) await empty.setSessionSetting('reasoning_effort', 'high');
  await empty.setSessionSetting('permissions', 'acceptEdits');
  const updated = (await empty.runtimeInfo()).persistence;
  report.updatedHandle = updated;
  await empty.release();
  const second = provider();
  const session = await second.resumeSession(updated, { tools: [{ name: 'read_source_session', description: 'Read quoted source context.', inputSchema: { type: 'object', properties: {} }, execute: async () => { report.sourceCalls++; return 'Quoted source evidence'; } }] }, { initializeEmpty: true });
  report.restored = await session.runtimeInfo();
  const witness = await session.nativeEvidence.prepareInput([{ type: 'text', text: 'Read the source session tool and acknowledge its quoted context.' }]);
  report.witness = witness;
  const stream = (async () => { for await (const item of session.observe()) { if (item.type !== 'observation') continue; report.normalized.push(item.event); if (item.event.type === 'interaction_requested' && item.event.request.kind === 'tool_approval') await session.respondToInteraction(item.event.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' }); } })();
  respond({ stage: 'prepared', sessionId: updated.sessionId });
  await session.nativeEvidence.dispatchInput(witness);
  report.started = await waitFor(async () => { const value = await session.nativeEvidence.inspectInput(witness); return value.status === 'materialized' && value.execution ? value : undefined; }, 'exact native input and start');
  report.completedReadiness = await waitFor(async () => { const value = await session.nativeEvidence.inspectReadiness(); report.lastReadiness = value; return value.idle && !value.pendingInputs && !value.pendingInteractions && !value.activeChildren ? value : undefined; }, 'authoritative native idle');
  await session.setSessionSetting('model', 'opus[1m]');
  await session.setSessionSetting('reasoning_effort', 'low');
  await session.setSessionSetting('permissions', 'dontAsk');
  report.latestConfirmed = await session.runtimeInfo();
  const finalHandle = report.latestConfirmed.persistence;
  await session.release(); await stream;
  const third = provider();
  const resumed = await third.resumeSession(finalHandle);
  report.coldRestored = await resumed.runtimeInfo();
  report.cold = await resumed.nativeEvidence.inspectInput(witness);
  try { await resumed.nativeEvidence.dispatchInput(witness); throw new Error('Old witness was replayed'); }
  catch (failure) { if (failure.message === 'Old witness was replayed') throw failure; report.coldReplayRejected = true; }
  await resumed.release();
  rawInput = new Channel();
  report.rawResumeFrames = [];
  raw = query({ prompt: rawInput, options: { resume: updated.sessionId, cwd: config.cwd, pathToClaudeCodeExecutable: config.executable, env: process.env,
    spawnClaudeCodeProcess(options) { const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe','pipe','pipe'] });
      rawExit = new Promise(resolve => child.once('exit', (code, signal) => { report.rawExit = { code, signal }; resolve(); })); return child; } } });
  rawPump = (async () => { for await (const frame of raw) report.rawResumeFrames.push(frame); })();
  report.rawInitialization = await raw.initializationResult();
  report.rawSettings = await raw.getSettings();
  rawInput.push({ type: 'user', uuid: randomUUID(), session_id: updated.sessionId, parent_tool_use_id: null, message: { role: 'user', content: 'Report the native restored configuration.' } });
  await waitFor(() => report.rawResumeFrames.some(frame => frame.type === 'result'), 'raw native resume result');
  rawInput.close(); raw.close(); await rawPump; await rawExit;

} catch (failure) { error = String(failure?.stack ?? failure); }
finally {
  if (raw) { rawInput?.close(); raw.close(); await rawPump?.catch(() => {}); await rawExit; }
  for (const instance of providers) { try { await instance.dispose(); } catch (failure) { report.cleanupError = String(failure); } }
  report.error = error;
  report.finishedAt = new Date().toISOString();
  await writeFile(config.result, JSON.stringify(report, null, 2));
  respond({ stage: 'done', error, cleanupError: report.cleanupError });
}
