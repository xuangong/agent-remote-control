import { expect, test } from 'vitest';
import { isTpmCreate, isTpmAction, isTpmWork, isTpmList } from './tpm.js';
import { decodeRemoteHostUplinkMessage, REMOTE_HOST_UPLINK_VERSION } from './remote-host-uplink.js';

test('TPM management envelopes permit only declared methods and routes', () => {
  for (const [method, path] of [['GET', '/remote/tpm'], ['GET', '/remote/tpm/work?id=one'], ['POST', '/remote/tpm/create'], ['POST', '/remote/tpm/action']]) {
    const message = { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'rpc_request', requestId: 'request', method, path, ...(method === 'POST' ? { body: '{}' } : {}) };
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(message)).status).toBe('ok');
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...message, method: method === 'GET' ? 'POST' : 'GET' })).status).toBe('rejected');
  }
  for (const path of ['/remote/tpm/destroy', '/remote/tpm/work/secret', '/remote/tpm#fragment']) expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'rpc_request', requestId: 'request', method: 'GET', path })).status).toBe('rejected');
});
test('TPM request contracts reject arbitrary extensions and invalid revisions', () => {
  const create = { providerId: 'codex', mainNativeSessionId: 'main', title: 'Work', requirement: 'Deliver feature', operationId: 'create' };
  expect(isTpmCreate({ providerId: 'codex', mainNativeSessionId: 'main', operationId: 'create' })).toBe(true);
  expect(isTpmCreate({ ...create, title: '' })).toBe(false);
  expect(isTpmCreate({ ...create, requirement: '' })).toBe(false);
  expect(isTpmCreate(create)).toBe(true); expect(isTpmCreate({ ...create, tools: [] })).toBe(false);
  expect(isTpmCreate({ ...create, requirement: '中'.repeat(16000) })).toBe(true);
  expect(isTpmCreate({ ...create, requirement: '中'.repeat(16001) })).toBe(false);
  expect(isTpmCreate({ ...create, requirement: '\u0000'.repeat(16000) })).toBe(false);
  const action = { id: 'work', revision: 1, operationId: 'pause', action: 'pause' };
  expect(isTpmAction({ ...action, action: 'rename', title: 'Amber Iris' })).toBe(true);
  expect(isTpmAction({ ...action, action: 'rename', title: '  ' })).toBe(false);
  expect(isTpmAction({ ...action, action: 'archive' })).toBe(true);
  expect(isTpmAction({ ...action, action: 'unarchive' })).toBe(true);
  expect(isTpmAction(action)).toBe(true); expect(isTpmAction({ ...action, revision: 0 })).toBe(false);
  expect(isTpmAction({ ...action, action: 'resolve', intentId: 'creation', resolution: 'accepted', nativeSessionId: 'native' })).toBe(true);
  expect(isTpmAction({ ...action, action: 'resolve' })).toBe(false);
});
test('work catalog round trips separate delivery, native identity, acceptance and health', () => {
  const work = { id: 'work', revision: 1, title: 'Work', providerId: 'codex', mainNativeSessionId: 'main', phase: 'implementing', waiting: 'main_session', paused: false, summary: 'Reviewing', nextAction: 'Read evidence', document: '# Spec', acceptance: 'Tests pass', evidence: [], createdAt: 'now', updatedAt: 'now', nextCheckAt: 10,
    outbox: [{ id: 'send', target: 'main', status: 'accepted', acceptance: 'queued', purpose: 'implementation', text: 'Build', createdAt: 'now' }] };
  expect(isTpmWork(work)).toBe(true); expect(isTpmList(JSON.parse(JSON.stringify({ supported: true, supportedProviders: ['codex'], works: [work] })))).toBe(true);
  expect(isTpmWork({ ...work, phase: 'running' })).toBe(false);
});

test('round trips role-bound work with a cross-provider current main and a pinned predecessor receipt', () => {
  const origin = { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'main' };
  const current = { ...origin, providerId: 'copilot', nativeSessionId: 'successor' };
  const work = { id: 'work', revision: 3, title: 'Work', providerId: 'codex', mainNativeSessionId: 'successor', tpmNativeSessionId: 'tpm',
    mainBinding: { kind: 'primary_role', roleId: 'primary', origin }, mainSessionRef: current,
    phase: 'implementing', waiting: 'main_session', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: 'now', updatedAt: 'now', nextCheckAt: 10,
    outbox: [{ id: 'send', target: 'main', status: 'unknown', purpose: 'implementation', text: 'Build', createdAt: 'now', resolvedTarget: origin, roleRevision: 1 }] };
  expect(isTpmWork(JSON.parse(JSON.stringify(work)))).toBe(true);
  expect(isTpmWork({ ...work, mainSessionRef: { nativeSessionId: 'successor' } })).toBe(false);
  expect(isTpmWork({ ...work, mainBinding: { kind: 'primary_role', roleId: 'primary' } })).toBe(false);
  expect(isTpmWork({ ...work, outbox: [{ ...work.outbox[0], resolvedTarget: { ...origin, controllerId: '' } }] })).toBe(false);
  expect(isTpmWork({ ...work, outbox: [{ ...work.outbox[0], roleRevision: 0 }] })).toBe(false);
});
