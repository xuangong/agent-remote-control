import { describe, expect, it } from 'vitest';
import { playControllerAgainstRelay, playRelayAgainstController, readTranscript, scenarios, transcriptNames } from '@orchardworks/agent-remote-fixtures';

/**
 * S2, Controller to Relay uplink, over the host wire (`remote-host-uplink`): registration, heartbeat, rpc and the outbox. The
 * transcripts were recorded from the real uplink client and the real Relay host connection joined in memory; each side is replayed
 * here against the other side's frames. The journal wire is in `journal-uplink.integration.test.ts`.
 */
const wire = ['register', 'heartbeat', 'rpc-attach', 'rpc-native-owner', 'outbox'];

describe('S2 host wire transcripts', () => {
  it('are all recorded and all scenarios', () => {
    expect(wire.every(name => transcriptNames('S2').includes(name) && scenarios.some(scenario => scenario.seam === 'S2' && scenario.name === name))).toBe(true);
  });

  describe('the Relay answers the Controller frames of the baseline', () => {
    it.each(wire)('%s', async name => {
      expect(await playControllerAgainstRelay(readTranscript('S2', name))).toBeGreaterThan(0);
    });
  });

  describe('the Controller answers the Relay frames of the baseline', () => {
    it.each(wire)('%s', async name => {
      expect(await playRelayAgainstController(readTranscript('S2', name))).toBeGreaterThan(0);
    });
  });
});
