import { describe, expect, it } from 'vitest';
import { playRole, readTranscript, recordScenario, scenarios, startRelay, transcriptNames, withoutStamp, type ScenarioContext } from '@orchardworks/agent-remote-fixtures';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';

/**
 * S3, Relay to browser session wire (`session-channel` and `session-control`): a browser stream against the Relay's real edge and journal
 * service, with an in-memory store and a scripted Controller. Replaying gives the transcripts recorded at baseline/im-session-2026-11-18.
 */
const context: ScenarioContext = { recording: () => { throw new Error('The session wire scenarios use no provider recording.'); } };
const sessionWire = scenarios.filter(scenario => scenario.seam === 'S3');

describe('S3 Relay to browser session wire: replaying the scenarios gives the baseline transcripts', () => {
  it('has a transcript for every scenario and a scenario for every transcript', () => {
    expect(transcriptNames('S3')).toEqual(sessionWire.map(scenario => scenario.name).sort());
  });

  it.each(sessionWire.map(scenario => scenario.name))('%s', async name => {
    const scenario = sessionWire.find(candidate => candidate.name === name)!;
    const replayed = await recordScenario(scenario, context, { protocolVersion: PROTOCOL_VERSION, recordedAt: '' });
    expect(withoutStamp(replayed)).toBe(withoutStamp(readTranscript('S3', name)));
  });
});

describe('S3 Relay to browser session wire: the Relay answers the baseline browser frames', () => {
  it.each(sessionWire.filter(scenario => scenario.relayBacking).map(scenario => scenario.name))('%s', async name => {
    const scenario = sessionWire.find(candidate => candidate.name === name)!;
    const relay = await startRelay({ ...(scenario.relayBacking!.seed ? { seed: true } : {}) });
    try {
      await scenario.relayBacking!.scenery?.(relay);
      const browser = await relay.openBrowser();
      expect(await playRole(readTranscript('S3', name), 'browser', browser.peer)).toBeGreaterThan(0);
    } finally { await relay.dispose(); }
  });
});
