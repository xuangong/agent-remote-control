import { expect, it } from 'vitest';
import { CALL_FOR_SUPPORT_REPORT_BYTES, callForSupportReportBytes, isCallForSupportCallInput, isCallForSupportGroup, isCallForSupportMandate, isCallForSupportProfile,
  isCallForSupportProfileInput, isCallForSupportReport, isCallForSupportRoster, isCallForSupportRosterProposal, type CallForSupportCall, type CallForSupportGroup,
  type CallForSupportMandate, type CallForSupportProfile, type CallForSupportReport } from './call-for-support.js';

const mandate: CallForSupportMandate = { supporters: [{ providerId: 'claude', model: 'opus', reasoningEffort: 'max' }, { providerId: 'codex', model: 'gpt-5.5' }],
  maxSupporters: 2, workspaces: ['shared', 'remote'], remoteHosts: [{ hostId: 'linux', workspace: '/srv/repo' }], approval: 'within_mandate',
  budget: { tokensPerCall: 1_000_000, tokensTotal: 10_000_000, costUsdTotal: 50 } };
const profile: CallForSupportProfile = { id: 'review', name: 'Cross review', description: 'Two independent reviewers.', mandate, coordinator: { model: 'gpt-5.5' },
  enableByDefault: false, revision: 1, updatedAt: 1 };
const report: CallForSupportReport = { status: 'reported', summary: 'One blocking finding.', findings: [{ id: 'f1', severity: 'blocking', location: 'src/a.ts:12',
  problem: 'Unchecked input.', suggestion: 'Validate it.', agreement: '2 of 2 reviewers', evidence: 'Both traced the call.' }],
  resources: [{ resourceId: 'r1', name: 'review.patch', mediaType: 'text/x-diff', byteLength: 10, sha256: 'a'.repeat(64) }] };
const call = (overrides: Partial<CallForSupportCall> = {}): CallForSupportCall => ({ id: 'c1', task: 'Review the change.', context: { commit: 'abcdef1', base: '1234567', files: ['src/a.ts'], conversation: true },
  deliverable: 'findings', origin: 'worker', status: 'open', createdAt: 1, usage: { tokens: 0 }, ...overrides });
const group = (overrides: Partial<CallForSupportGroup> = {}): CallForSupportGroup => ({ profileId: 'review', profileRevision: 1, role: 'Cross review', description: '',
  mandate, coordinator: { providerId: 'codex', model: 'gpt-5.5' }, status: 'active', calls: [call()], ledger: { text: '', revision: 0 }, usage: { tokens: 0 }, ...overrides });

it('accepts complete profiles, groups, reports and rosters', () => {
  expect(isCallForSupportProfile(profile)).toBe(true);
  const { id: _id, revision: _revision, updatedAt: _updatedAt, ...input } = profile;
  expect(isCallForSupportProfileInput(input)).toBe(true);
  expect(isCallForSupportReport(report)).toBe(true);
  expect(callForSupportReportBytes(report)).toBeLessThan(CALL_FOR_SUPPORT_REPORT_BYTES);
  const roster = { id: 'roster', status: 'pending', members: [{ name: 'Opus reviewer', responsibility: 'Review for correctness.', providerId: 'claude', model: 'opus',
    reasoningEffort: 'max', workspace: 'shared' }, { name: 'Linux tester', responsibility: 'Run the tests.', providerId: 'codex', model: 'gpt-5.5', workspace: 'remote', hostId: 'linux' }],
    release: ['old'], rationale: 'Independent providers.', withinMandate: true, createdAt: 2 };
  expect(isCallForSupportRoster(roster)).toBe(true);
  expect(isCallForSupportGroup(group({ roster: roster as never, calls: [call({ status: 'reported', report, reportedAt: 3 }), call({ id: 'c2', followUpOf: 'c1' })] }))).toBe(true);
  expect(isCallForSupportCallInput({ task: 'Review.', deliverable: 'patch' })).toBe(true);
});

it('bounds mandates', () => {
  expect(isCallForSupportMandate({ ...mandate, maxSupporters: 6 })).toBe(true);
  for (const invalid of [{ ...mandate, maxSupporters: 0 }, { ...mandate, maxSupporters: 7 }, { ...mandate, supporters: [] },
    { ...mandate, supporters: Array.from({ length: 9 }, (_, index) => ({ providerId: 'codex', model: `m${index}` })) },
    { ...mandate, supporters: [mandate.supporters[0], mandate.supporters[0]] }, { ...mandate, workspaces: [] }, { ...mandate, workspaces: ['shared', 'shared'] },
    { ...mandate, remoteHosts: [] }, { ...mandate, remoteHosts: [mandate.remoteHosts[0], mandate.remoteHosts[0]] }, { ...mandate, approval: 'never' },
    { ...mandate, budget: { tokensTotal: 0 } }, { ...mandate, budget: { costUsdTotal: 0 } }, { ...mandate, extra: true }]) {
    expect(isCallForSupportMandate(invalid)).toBe(false);
  }
  expect(isCallForSupportMandate({ ...mandate, workspaces: ['shared'], remoteHosts: [] })).toBe(true);
});

it('bounds profiles, calls and reports', () => {
  expect(isCallForSupportProfile({ ...profile, name: 'x'.repeat(128) })).toBe(true);
  for (const invalid of [{ ...profile, name: 'x'.repeat(129) }, { ...profile, name: ' ' }, { ...profile, description: 'x'.repeat(4001) }, { ...profile, revision: 0 },
    { ...profile, mandate: { ...mandate, remoteHosts: [] } }, { ...profile, unknown: 1 }]) expect(isCallForSupportProfile(invalid)).toBe(false);
  expect(isCallForSupportCallInput({ task: 'x'.repeat(12000), deliverable: 'answer' })).toBe(true);
  for (const invalid of [{ task: 'x'.repeat(12001), deliverable: 'answer' }, { task: '', deliverable: 'answer' }, { task: 'Review.', deliverable: 'essay' },
    { task: 'Review.', deliverable: 'answer', context: { commit: 'HEAD' } }, { task: 'Review.', deliverable: 'answer', context: { files: Array(65).fill('a') } }]) {
    expect(isCallForSupportCallInput(invalid)).toBe(false);
  }
  const finding = report.findings[0]!;
  expect(isCallForSupportReport({ ...report, findings: Array.from({ length: 64 }, (_, index) => ({ ...finding, id: `f${index}` })) })).toBe(true);
  for (const invalid of [{ ...report, findings: Array.from({ length: 65 }, (_, index) => ({ ...finding, id: `f${index}` })) }, { ...report, findings: [finding, finding] },
    { ...report, summary: '' }, { ...report, findings: [{ ...finding, severity: 'fatal' }] }, { ...report, findings: [{ ...finding, evidence: 'x'.repeat(4001) }] },
    { ...report, resources: [] }]) expect(isCallForSupportReport(invalid)).toBe(false);
});

it('requires a host exactly for remote roster members', () => {
  const member = { name: 'Reviewer', responsibility: '', providerId: 'codex', model: 'gpt-5.5', workspace: 'shared' };
  expect(isCallForSupportRosterProposal({ members: [member], rationale: '' })).toBe(true);
  expect(isCallForSupportRosterProposal({ members: [{ ...member, hostId: 'linux' }], rationale: '' })).toBe(false);
  expect(isCallForSupportRosterProposal({ members: [{ ...member, workspace: 'remote' }], rationale: '' })).toBe(false);
  expect(isCallForSupportRosterProposal({ members: Array(7).fill(member), rationale: '' })).toBe(false);
  expect(isCallForSupportRosterProposal({ members: [], rationale: '' })).toBe(false);
});

it('keeps one open call and reports consistent with their calls', () => {
  expect(isCallForSupportGroup(group({ calls: [call(), call({ id: 'c2' })] }))).toBe(false);
  expect(isCallForSupportGroup(group({ calls: [call(), call()] }))).toBe(false);
  expect(isCallForSupportGroup(group({ calls: [call({ status: 'reported' })] }))).toBe(false);
  expect(isCallForSupportGroup(group({ calls: [call({ status: 'failed', report, reportedAt: 2 })] }))).toBe(false);
  expect(isCallForSupportGroup(group({ calls: [call({ report, reportedAt: 2 })] }))).toBe(false);
  expect(isCallForSupportGroup(group({ calls: [call({ id: 'c1', followUpOf: 'c1' })] }))).toBe(false);
  expect(isCallForSupportGroup(group({ calls: Array.from({ length: 65 }, (_, index) => call({ id: `c${index}`, status: 'queued' })) }))).toBe(false);
  expect(isCallForSupportGroup(group({ ledger: { text: 'x'.repeat(16001), revision: 1 } }))).toBe(false);
  expect(isCallForSupportGroup(group({ status: 'paused_budget', pauseReason: 'Token budget reached.' }))).toBe(true);
});
