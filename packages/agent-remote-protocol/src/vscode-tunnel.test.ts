import { expect, test } from 'vitest';
import { vscodeWorkspaceLink, vscodeTunnelLink } from './vscode-tunnel.js';

test('encodes workspace segments without letting paths alter the tunnel authority', () => {
  expect(vscodeWorkspaceLink('desktop', '/Users/me/a #?%/中文')).toBe('https://vscode.dev/tunnel/desktop/Users/me/a%20%23%3F%25/%E4%B8%AD%E6%96%87');
  expect(vscodeWorkspaceLink('desktop', 'C:\\work\\project')).toBe('https://vscode.dev/tunnel/desktop/C%3A/work/project');
  expect(vscodeWorkspaceLink('desktop', '/')).toBe('https://vscode.dev/tunnel/desktop/');
  expect(vscodeWorkspaceLink('desktop', '/work/../secret')).toBeUndefined();
  expect(vscodeWorkspaceLink('desktop', './relative')).toBeUndefined();
  expect(vscodeTunnelLink('evil/../../')).toBeUndefined();
});
