import { expect, it } from 'vitest';
import { isTeamHostCall } from './team.js';

const seat = { teamId: 'team', memberId: 'leader' };
it('accepts bounded file transfer calls independently of Team message text', () => {
  expect(isTeamHostCall({ ...seat, action: 'resource_begin', operationId: 'upload', name: 'fixture.zip', mediaType: 'application/zip', byteLength: 300000, sha256: 'a'.repeat(64) })).toBe(true);
  expect(isTeamHostCall({ ...seat, action: 'resource_chunk', operationId: 'upload', offset: 0, contentBase64: 'YQ==' })).toBe(true);
  expect(isTeamHostCall({ ...seat, action: 'send', operationId: 'send', to: 'worker', text: 'Inspect the fixture.', resources: ['resource'] })).toBe(true);
});
it('rejects oversized resource lists, invalid digests and excessive chunks', () => {
  expect(isTeamHostCall({ ...seat, action: 'send', operationId: 'send', to: 'worker', text: 'Inspect.', resources: Array.from({length: 9}, (_, index) => `r${index}`) })).toBe(false);
  expect(isTeamHostCall({ ...seat, action: 'resource_begin', operationId: 'upload', name: 'fixture.zip', mediaType: 'application/zip', byteLength: 300000, sha256: 'bad' })).toBe(false);
  expect(isTeamHostCall({ ...seat, action: 'resource_chunk', operationId: 'upload', offset: 0, contentBase64: 'x'.repeat(45000) })).toBe(false);
});
