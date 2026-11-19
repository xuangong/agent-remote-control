/**
 * Whether this device can reach the Relay: the one connection indicator of the page (target T5, Orchard decision 5).
 * Pure. Sessions never say anything about their own connection; this view speaks for the whole page.
 *
 * | facts                                                    | view      |
 * | the Relay asked this page to sign in again               | `sign_in` |
 * | the browser is offline, access is not confirmed, or the activity channel was lost | `offline` |
 * | otherwise, including a channel never opened yet (`unknown`) | `online` |
 */

/** The link of the activity channel: `down` after it was up and failed, or missed its first open deadline, until it reopens. */
export type ChannelLink = 'unknown' | 'up' | 'down';

export interface RelayLinkFacts {
  readonly accessReady: boolean;
  readonly needsSignIn: boolean;
  readonly channel: ChannelLink;
  readonly browserOnline: boolean;
}

export type RelayLinkView = { readonly state: 'online' } | { readonly state: 'offline' } | { readonly state: 'sign_in' };

export function relayLinkView(facts: RelayLinkFacts): RelayLinkView {
  if (facts.needsSignIn) return { state: 'sign_in' };
  if (!facts.browserOnline || !facts.accessReady || facts.channel === 'down') return { state: 'offline' };
  return { state: 'online' };
}
