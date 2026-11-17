import { describe, expect, it } from 'vitest';
import * as claude from '@orchardworks/agent-provider-claude/recordings';
import * as codex from '@orchardworks/agent-provider-codex/recordings';
import * as copilot from '@orchardworks/agent-provider-copilot/recordings';
import { journalServicePeer, playRole, readTranscript, recordScenario, scenarios, transcriptNames, withoutStamp, type ScenarioContext } from '@orchardworks/agent-remote-fixtures';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';

/**
 * S2, Controller to Relay uplink, over the journal wire (`remote-host-journal`): the real journal publisher with a scripted provider and the
 * Relay's real journal service over in-memory hand-offs. Both ends consume the transcripts recorded at baseline/im-session-2026-11-18.
 */
const context: ScenarioContext = { recording: (provider, name) => ({ claude, codex, copilot })[provider].recording(name) };
const uplink = scenarios.filter(scenario => scenario.seam === 'S2');

describe('S2 Controller to Relay uplink: replaying the scenarios gives the baseline transcripts', () => {
  it('has a transcript for every scenario and a scenario for every transcript', () => {
    expect(transcriptNames('S2')).toEqual(uplink.map(scenario => scenario.name).sort());
  });

  it.each(uplink.map(scenario => scenario.name))('%s', async name => {
    const scenario = uplink.find(candidate => candidate.name === name)!;
    const replayed = await recordScenario(scenario, context, { protocolVersion: PROTOCOL_VERSION, recordedAt: '' });
    expect(withoutStamp(replayed)).toBe(withoutStamp(readTranscript('S2', name)));
  });
});

describe('S2 Controller to Relay uplink: the Relay answers the baseline Controller frames', () => {
  it.each(uplink.filter(scenario => scenario.relayBacking).map(scenario => scenario.name))('%s', async name => {
    const scenario = uplink.find(candidate => candidate.name === name)!;
    const relay = journalServicePeer(scenario.relayBacking!.uplink);
    try {
      expect(await playRole(readTranscript('S2', name), 'controller', relay.peer)).toBeGreaterThan(0);
    } finally { relay.close(); }
  });
});
