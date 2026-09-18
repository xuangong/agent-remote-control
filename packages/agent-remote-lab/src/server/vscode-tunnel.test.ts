// @vitest-environment node
import { expect, test } from 'vitest';
import { previewFixture } from './preview-tunnel-fixture.js';

test('manages a real child over authenticated HTTP and the Host WebSocket uplink', async () => {
  const script = `
    if (process.argv.includes('--help')) { console.log('Usage: code tunnel --accept-server-license-terms --cli-data-dir'); process.exit(0); }
    console.log('To grant access to the server, please log into https://github.com/login/device and use code ABCD-1234');
    setInterval(() => {}, 1000);
  `;
  const { alice, bob, hostId, host } = await previewFixture({ vscodeTunnel: {
    executable: process.execPath, executableArgs: ['-e', script, '--'], statusIntervalMs: 60_000, stopTimeoutMs: 100,
  } });
  const path = `v1/remote/hosts/${hostId}/vscode-tunnel`;
  const stopped = await alice.request(path);
  expect(stopped.headers.get('cache-control')).toBe('no-store');
  expect(await stopped.json()).toMatchObject({ status: 'stopped', processAlive: false });
  expect((await bob.request(path + '/start', { acceptLicense: true })).status).toBe(404);
  expect((await alice.request(path + '/start', {})).status).toBe(400);
  expect((await alice.request(path + '/start', { acceptLicense: true })).status).toBe(200);
  await expect.poll(async () => (await (await alice.request(path)).json()).authorization?.code).toBe('ABCD-1234');
  const state = await (await alice.request(path)).json();
  process.kill(state.pid, 'SIGTERM');
  await expect.poll(async () => (await (await alice.request(path)).json()).status).toBe('exited');
  await alice.request(path + '/start', { acceptLicense: true });
  const stoppedAgain = await alice.request(path + '/stop', {});
  expect(await stoppedAgain.json()).toMatchObject({ status: 'stopped', processAlive: false });
  await host.close();
  await expect.poll(async () => (await alice.request(path)).status).toBe(503);
});
