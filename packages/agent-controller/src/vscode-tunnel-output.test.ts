import { expect, test } from 'vitest';
import { parseTunnelOutput, tunnelOutputLines } from './vscode-tunnel-output.js';

test('accepts ANSI banners and machine events but rejects untrusted authorization URLs', () => {
  expect(parseTunnelOutput('\x1b[32m  ➜  Tunnel:   test-machine\x1b[0m')).toEqual({ type: 'connected', name: 'test-machine' });
  expect(parseTunnelOutput('__VSCODE_CLI_STATUS__{"type":"connected","tunnelName":"desktop","isAttached":true}'))
    .toEqual({ type: 'connected', name: 'desktop', attached: true });
  expect(parseTunnelOutput('__VSCODE_CLI_STATUS__{"type":"tokenError"}')).toEqual({ type: 'tokenError' });
  expect(parseTunnelOutput('please log into https://github.com.evil.test/login/device and use code 9491-B98B')).toBeUndefined();
  expect(parseTunnelOutput('__VSCODE_CLI_STATUS__{broken')).toBeUndefined();
});

test('reassembles chunks and drops oversized lines before resuming', () => {
  const lines: string[] = [];
  const receive = tunnelOutputLines(line => lines.push(line));
  receive('first'); receive(' line\r\n'); receive('x'.repeat(100_000));
  receive('\nTunnel: desktop\n');
  expect(lines).toEqual(['first line', 'Tunnel: desktop']);
});
