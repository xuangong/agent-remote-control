import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeOpenCodeNativeFixture, waitFor } from './lib/opencode-native-fixture.mjs';

const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;

// Verify native admission and history directly, without a built adapter or remote model.
test('OpenCode v2 keeps durable admission separate from executed message history', { skip: !executable, timeout: 90000 }, async (t) => {
  const report = {};
  const fixture = await makeOpenCodeNativeFixture(t.signal, report);
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${fixture.adapterOptions.password}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
  async function request(path, method = 'GET', body, expected = 200) {
    const response = await fetch(fixture.serverUrl + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(10000)]),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
  try {
    await fixture.start();
    assert.equal(report.identity.version, '2.0.25', 'Revalidate the observed native boundaries before changing this pin.');
    const { data: session } = await request('/api/session', 'POST', { location: { directory: fixture.cwd }, title: 'Admission boundary' });
    const path = `/api/session/${session.id}`;
    await request(path + '/model', 'POST', { model: { id: 'fixture', providerID: 'arc' } }, 204);
    const prompt = { id: 'msg_native_admission_boundary', text: 'NATIVE_ORIGINAL_INPUT', delivery: 'steer', resume: false };
    const admitted = (await request(path + '/prompt', 'POST', prompt)).data;
    assert.equal(admitted.id, prompt.id);
    assert.equal(admitted.payload.text, prompt.text);
    const duplicate = (await request(path + '/prompt', 'POST', { ...prompt, text: 'MUST_NOT_REPLACE_ORIGINAL' })).data;
    assert.equal(duplicate.id, admitted.id);
    assert.equal(duplicate.payload.text, prompt.text, 'Native prompt IDs retain the first admitted payload.');
    assert.deepEqual((await request(path + '/inbox')).data.map(item => item.id), [prompt.id]);
    assert.ok(!(await request('/api/session/active')).data[session.id]);
    assert.ok(!(await request(path + '/message?limit=200&order=asc')).data.some(item => item.type === 'user'));
    assert.equal(report.modelRequests.length, 0, 'Admission alone must not start a model request.');
    assert.deepEqual(await request(path + '/interrupt', 'POST', {}), { interrupted: false });
    assert.deepEqual((await request(path + '/inbox')).data.map(item => item.id), [prompt.id], 'Interrupting an idle session does not cancel its inbox.');
    const { data: other } = await request('/api/session', 'POST', { location: { directory: fixture.cwd }, title: 'Other session' });
    await request(`/api/session/${other.id}/prompt`, 'POST', prompt, 409);
    assert.equal((await request(`/api/session/${other.id}/inbox`)).data.length, 0);

    await fixture.stop();
    await fixture.start();
    const recovered = (await request(path + '/inbox')).data;
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, admitted.id);
    assert.equal(recovered[0].payload.text, prompt.text);
    assert.ok(!(await request('/api/session/active')).data[session.id]);
    assert.equal(report.modelRequests.length, 0, 'A durable inbox must not imply that execution resumed after restart.');
    await request(path + '/prompt', 'POST', { ...prompt, resume: true });
    const history = await waitFor(async () => {
      const messages = (await request(path + '/message?limit=200&order=asc')).data;
      return messages.at(-1)?.type === 'idle' && messages.at(-1).outcome === 'succeeded' && messages;
    }, t.signal, 'terminal native history', 25000);
    assert.ok(!(await request('/api/session/active')).data[session.id]);
    assert.equal((await request(path + '/inbox')).data.length, 0);
    assert.deepEqual(history.filter(item => item.type === 'user').map(item => ({ id: item.id, text: item.text })), [{ id: prompt.id, text: prompt.text }]);
    assert.ok(history.some(item => item.type === 'assistant' && item.content.some(part => part.type === 'text' && part.text === 'Fixture complete')));
    assert.ok(report.modelRequests.length > 0, 'The real native execution must call the isolated local model.');

    const latest = await request(path + '/message?limit=1&order=desc');
    assert.ok(latest.cursor.next);
    await request(path + `/message?limit=1&order=desc&cursor=${encodeURIComponent(latest.cursor.next)}`, 'GET', undefined, 400);
    const paged = [...latest.data];
    let cursor = latest.cursor.next;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber <= history.length; pageNumber++) {
      assert.ok(!seen.has(cursor), 'The native cursor must advance.');
      seen.add(cursor);
      const page = await request(path + `/message?limit=1&cursor=${encodeURIComponent(cursor)}`);
      if (!page.data.length) break;
      paged.push(...page.data);
      assert.ok(page.cursor.next);
      cursor = page.cursor.next;
    }
    assert.deepEqual(paged.map(item => item.id), [...history].reverse().map(item => item.id), 'Opaque cursor pagination must cover every executed record once.');
    const completedDuplicate = (await request(path + '/prompt', 'POST', { ...prompt, text: 'STILL_NOT_A_REPLACEMENT' })).data;
    assert.equal(completedDuplicate.payload.text, prompt.text);
    assert.equal((await request(path + '/inbox')).data.length, 0, 'An executed prompt ID must not be queued again.');
    await fixture.stop();
    await fixture.start();
    const restored = (await request(path + '/message?limit=200&order=asc')).data;
    assert.deepEqual(restored.map(item => item.id), history.map(item => item.id));
    assert.equal((await request(path)).data.outcome, 'succeeded');
    report.boundaries = {
      admissionPrecedesExecution: true, firstAdmissionWins: true, identityIsSessionBound: true,
      idleInterruptPreservesInbox: true, pendingInboxSurvivesRestart: true,
      executedHistorySurvivesRestart: true, cursorCarriesOrdering: true,
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nNative diagnostics:\n${fixture.diagnostics()}`, { cause: error });
  } finally {
    await fixture.cleanup();
    console.log(JSON.stringify(fixture.sanitize(report)));
  }
});
