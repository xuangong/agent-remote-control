import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRelayConfiguration, composeEnvironment } from './relay-local-config.mjs';

const input = { runtime: 'node', gatewayPort: 49121, relayPort: 49122, gatewayImage: 'local/agent-gateway:test', secret: 'local-test-secret-01234567890123456789' };
test('requires an explicit runtime and distinct valid local ports', { timeout: 1000 }, () => {
  for (const runtime of [undefined, 'auto', 'node,workers']) assert.throws(() => localRelayConfiguration({ ...input, runtime }), /runtime/i);
  for (const relayPort of [0, 65536, '49122extra', input.gatewayPort]) assert.throws(() => localRelayConfiguration({ ...input, relayPort }), /port/i);
  assert.throws(() => localRelayConfiguration({ ...input, gatewayImage: '' }), /image/i);
});
test('uses matching canonical origins for browser and services in either runtime', { timeout: 1000 }, () => {
  for (const runtime of ['node', 'workers']) {
    const config = localRelayConfiguration({ ...input, runtime });
    assert.equal(config.gatewayUrl, 'http://127.0.0.1:49121');
    assert.equal(config.relayUrl, 'http://127.0.0.1:49122');
    assert.equal(config.projectName, `arc-relay-${runtime}`);
    const env = composeEnvironment(config);
    assert.match(env, /AGENT_REMOTE_ISSUER=http:\/\/127.0.0.1:49121\n/);
    assert.match(env, /AGENT_REMOTE_RELAY_URL=http:\/\/127.0.0.1:49122\n/);
    assert.match(env, /AGENT_REMOTE_GATEWAY_IMAGE=local\/agent-gateway:test\n/);
  }
});
test('rejects unsafe configuration text and weak signing secrets', { timeout: 1000 }, () => {
  assert.throws(() => localRelayConfiguration({ ...input, secret: 'short' }), /secret/i);
  assert.throws(() => localRelayConfiguration({ ...input, secret: 'a'.repeat(32) + '\nINJECT=1' }), /secret/i);
  assert.throws(() => localRelayConfiguration({ ...input, gatewayImage: 'image\nINJECT=1' }), /image/i);
});
