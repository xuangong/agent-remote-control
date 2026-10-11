import { expect, it } from 'vitest';
import { openCodeVersionIssue, parseOpenCodeCliVersion, supportsOpenCodeVersion } from './compatibility.js';

it.each([
  ['1.18.18\n', '1.18.18'],
  ['v1.19.0', '1.19.0'],
  ['opencode v2.0.25\n', '2.0.25'],
  ['opencode 1.18.31', '1.18.31'],
  ['OpenCode v1.18.31', '1.18.31'],
])('reads the native CLI display %j without treating it as API compatibility', (display, version) => {
  expect(parseOpenCodeCliVersion(display)).toBe(version);
}, 1_000);

it.each(['', '2.0.25 extra', 'another-agent v1.18.18', '1.18.18\nwarning', '1.18.18-dev', 'unavailable'])('rejects an ambiguous CLI display %j', display => {
  expect(parseOpenCodeCliVersion(display)).toBeUndefined();
}, 1_000);

it.each(['2.0.25', '2.0.26', '2.1.0'])('admits the supported 2.x API version %s', version => {
  expect(supportsOpenCodeVersion(version)).toBe(true);
  expect(openCodeVersionIssue(version)).toBeUndefined();
}, 1_000);

it.each(['1.18.18', '1.19.0', '3.0.0'])('explains the unsupported native API generation %s', version => {
  expect(supportsOpenCodeVersion(version)).toBe(false);
  expect(openCodeVersionIssue(version)).toEqual({
    code: 'opencode_api_unsupported',
    message: `OpenCode ${version} uses a different server API. This Controller requires OpenCode 2.x (2.0.25 or newer).`,
  });
}, 1_000);

it.each([undefined, 'dev', '2.0.24', 'opencode v2.0.25'])('rejects an unsupported API version %j without parsing it as CLI output', version => {
  expect(supportsOpenCodeVersion(version)).toBe(false);
  expect(openCodeVersionIssue(version)).toMatchObject({ code: 'opencode_version_unsupported', message: expect.stringContaining('OpenCode 2.x (2.0.25 or newer)') });
}, 1_000);
