/**
 * Declared by an adapter whose timeline observations all carry `itemIdentity`, and whose live and reread observations of
 * one native item agree on it. The adapter proves that with continuity fixtures. Only such adapters have their sessions
 * published to Relay journals; the others keep today's forwarding.
 */
export interface AgentJournalCapability {
  readonly itemIdentity: 1;
}

export function supportsJournal(adapter: { readonly journal?: AgentJournalCapability }): boolean {
  return adapter.journal?.itemIdentity === 1;
}
