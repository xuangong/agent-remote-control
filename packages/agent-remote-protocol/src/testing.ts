/**
 * What tests of other packages use as frozen counterparts of the wire: the Team and uplink codecs as they were before the Team call
 * negotiation, so a current peer is checked against what an older peer sends and understands.
 */
export { isTeam as isLegacyTeam } from './testing/legacy-team/team.js';
export { decodeRemoteHostUplinkMessage as decodeLegacyRemoteHostUplinkMessage } from './testing/legacy-team/remote-host-uplink.js';
