import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { makeOpenCodeNativeFixture, waitFor } from './lib/opencode-native-fixture.mjs';

const enabled = process.env.AGENT_OPENCODE_SUCCESSION_EVIDENCE === '1' || process.env.AGENT_OPENCODE_ACTUAL_SUCCESSION === '1';

test('OpenCode actual adapter gates unsupported handoff and preserves ordinary input across restart', { skip: !enabled, timeout: 110000 }, async t => {
  const report = { startedAt: new Date().toISOString(), cases: [] };
  let fixture, provider;
  const originalFetch = globalThis.fetch;
  let discardNextPromptResponse = false;
  try {
    fixture = await makeOpenCodeNativeFixture(t.signal, report);
    await fixture.start();
    globalThis.fetch = async (...args) => {
      const input = args[0], url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = args[1]?.method ?? input.method ?? 'GET';
      const own = url.origin === fixture.serverUrl;
      const row = { path: url.pathname, method };
      if (own) report.requests.push(row);
      const response = await originalFetch(...args);
      if (own) row.status = response.status;
      if (own && discardNextPromptResponse && method === 'POST' && url.pathname.endsWith('/prompt')) {
        discardNextPromptResponse = false;
        await response.arrayBuffer(); row.responseDiscarded = true;
        throw new TypeError('Isolated lost prompt acknowledgement');
      }
      return response;
    };
    const { OpenCodeAgentProvider } = await import('../packages/agent-provider-opencode/dist/index.js');
    const connect = () => new OpenCodeAgentProvider(fixture.adapterOptions);
    provider = connect();
    const messages = async id => (await fixture.api(`/api/session/${id}/message?limit=200&order=asc`)).data;
    const beforeGate = report.requests.length;
    assert.equal(provider.nativeEvidence.availability().status, 'unavailable');
    await assert.rejects(() => provider.nativeEvidence.createEmpty({ sessionId: randomUUID(), cwd: fixture.cwd }), { code: 'native_evidence_unsupported' });
    assert.equal(report.requests.length, beforeGate, 'Unsupported handoff must stop before any native request.');
    const create = async () => {
      const before = report.modelRequests.length;
      const session = await provider.createSession({ sessionId: randomUUID(), cwd: fixture.cwd });
      const handle = (await session.runtimeInfo()).persistence;
      assert.ok(handle); assert.deepEqual(await messages(handle.sessionId), []);
      assert.equal(report.modelRequests.length, before, 'Ordinary empty creation must not execute a model request.');
      return { session, handle };
    };
    const a = await create();
    assert.equal(a.session.nativeEvidence.availability().status, 'unavailable');
    const beforeInputGate = report.requests.length;
    await assert.rejects(() => a.session.nativeEvidence.prepareInput([{ type: 'text', text: 'Must not dispatch' }]), { code: 'native_evidence_unsupported' });
    await assert.rejects(() => a.session.nativeEvidence.dispatchInput({}), { code: 'native_evidence_unsupported' });
    assert.equal((await a.session.nativeEvidence.inspectInput({})).status, 'unknown');
    assert.equal(report.requests.slice(beforeInputGate).filter(row => row.method !== 'GET').length, 0);
    const acceptances = [];
    await a.session.sendMessage('Count amber birch cedar.', { onAcceptance: value => acceptances.push(value) });
    assert.deepEqual(acceptances, [{ disposition: 'queued' }]);
    await waitFor(async () => (await messages(a.handle.sessionId)).at(-1)?.type === 'idle', t.signal, 'native assistant reply');
    report.cases.push({ kind: 'unsupported-prepared-input-no-effect', status: 'verified' });

    const b = await create(), c = await create();
    // Untitled sessions start a separate title-model request that carries the same user text.
    await provider.renameSession(b.handle.sessionId, 'Lost acknowledgement fixture');
    await provider.close(); provider = undefined;
    await fixture.stop(true); await fixture.start();
    provider = connect();
    const recovered = await provider.resumeSession(c.handle);
    assert.equal((await recovered.runtimeInfo()).sessionId, c.handle.sessionId);
    assert.deepEqual(await messages(c.handle.sessionId), []);
    report.cases.push({ kind: 'exact-empty-session-after-native-restart', status: 'verified', nativeId: c.handle.sessionId });

    const live = await provider.resumeSession(b.handle);
    const text = 'Hold this isolated turn until the crash evidence has been captured.';
    const lostAcceptances = [];
    fixture.hold(text); discardNextPromptResponse = true;
    await assert.rejects(() => live.sendMessage(text, { onAcceptance: value => lostAcceptances.push(value) }));
    await waitFor(() => fixture.held(), t.signal, 'held native model request');
    assert.deepEqual(lostAcceptances, [], 'A held model request alone does not prove a native assistant record exists.');
    fixture.startHeldOutput();
    await waitFor(async () => {
      report.lostAckHistory = await messages(b.handle.sessionId);
      report.lostAcceptances = lostAcceptances;
      return lostAcceptances.some(value => value.disposition === 'started');
    }, t.signal, 'ordinary input reconciliation without persisted log');
    assert.equal(lostAcceptances.filter(value => value.disposition === 'started').length, 1);
    const promptCount = report.requests.filter(row => row.method === 'POST' && row.path.endsWith('/prompt')).length;
    const initialHistory = await messages(b.handle.sessionId);
    const delivered = initialHistory.filter(message => message.type === 'user' && message.text === text);
    assert.equal(delivered.length, 1);
    const response = initialHistory[initialHistory.findIndex(message => message.id === delivered[0].id) + 1];
    assert.equal(response?.type, 'assistant', 'Only an adjacent persisted native assistant can settle the lost acknowledgement.');
    assert.equal(response.time.completed, undefined, 'The crash probe must interrupt an unfinished native step.');
    assert.equal(report.modelRequests.filter(request => request.held).length, 1, 'Only the task model request is held; title generation must not compete for the response gate.');
    await provider.close(); provider = undefined;
    await fixture.stop(true);
    const modelCount = report.modelRequests.length;
    await fixture.start(); provider = connect();
    const reopened = await provider.resumeSession(b.handle);
    const history = await messages(b.handle.sessionId);
    assert.equal(history.filter(message => message.id === delivered[0].id && message.type === 'user').length, 1);
    assert.equal(reopened.nativeEvidence.availability().status, 'unavailable');
    await delay(250);
    assert.equal(report.modelRequests.length, modelCount, 'Read-only recovery must not execute the input again.');
    assert.equal(report.requests.filter(row => row.method === 'POST' && row.path.endsWith('/prompt')).length, promptCount);
    assert.equal(report.requests.filter(row => row.method === 'POST' && row.path === '/api/session').length, 3);
    report.cases.push({ kind: 'ordinary-lost-ack-and-native-restart', status: 'verified', promptCount });
  } catch (error) {
    report.error = error.message;
    throw new Error(`${error.message}\n${fixture?.diagnostics() ?? ''}`, { cause: error });
  } finally {
    await provider?.close(); globalThis.fetch = originalFetch;
    await fixture?.cleanup(); report.finishedAt = new Date().toISOString();
    const output = process.env.AGENT_OPENCODE_SUCCESSION_EVIDENCE_OUTPUT;
    if (output) await writeFile(output, JSON.stringify(fixture?.sanitize(report) ?? report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ cases: report.cases, cleanup: report.cleanup, output: output ?? null }));
  }
});
