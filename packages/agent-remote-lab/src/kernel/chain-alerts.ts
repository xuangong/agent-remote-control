// The chains that passed a threshold of the person's and that they have not yet seen in the audit (bots design 7). The Relay's push
// tells a device that is subscribed and not showing the session; this is the page's own sign, which needs no push: a needs-you mark on
// the chain's first bot in Chats and a count on Settings. A chain is seen when the audit shows it with what it passed; a chain that
// later passes another threshold is unseen again. What was seen is kept on this device, per account address.
import { useContext, useEffect, useSyncExternalStore } from 'react';
import { RemoteChainClient, watchList } from '@orchardworks/agent-client';
import type { BotChain } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from './workspace-access.js';
import { TeamRefresh } from './useTeamRoster.js';

/** A passed chain the person has not seen: its first bot, by record id. */
export interface ChainAlert { readonly chainId: string; readonly bot: string }

const seenKey = (baseUrl: string) => `arc.chains-seen:${baseUrl}`;
const passedKey = (chain: BotChain) => (chain.passed ?? []).join(',');
function readSeen(baseUrl: string): Record<string, string> {
  try { const value = JSON.parse(localStorage.getItem(seenKey(baseUrl)) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/** The chains of `chains` that passed a threshold and whose passed items `seen` does not hold. */
export function unseenChains(chains: readonly BotChain[], seen: Readonly<Record<string, string>>): ChainAlert[] {
  return chains.filter(chain => chain.passed?.length && seen[chain.id] !== passedKey(chain)).map(chain => ({ chainId: chain.id, bot: chain.bot }));
}

let account: { baseUrl: string; chains: readonly BotChain[] } | undefined;
let alerts: readonly ChainAlert[] = [];
const listeners = new Set<() => void>();
const recompute = () => { alerts = account ? unseenChains(account.chains, readSeen(account.baseUrl)) : []; for (const listener of listeners) listener(); };

/** The chains as the Relay last said them, from the poll or the audit. */
export function observeChains(baseUrl: string, chains: readonly BotChain[]): void { account = { baseUrl, chains }; recompute(); }
/** The audit shows every chain it last read: they are seen, with what they passed. */
export function markChainsSeen(baseUrl: string): void {
  if (account?.baseUrl !== baseUrl) return;
  const seen = readSeen(baseUrl);
  for (const chain of account.chains) if (chain.passed?.length) seen[chain.id] = passedKey(chain);
  try { localStorage.setItem(seenKey(baseUrl), JSON.stringify(seen)); } catch { /* a device without storage shows the sign until the page is reloaded */ }
  recompute();
}
// Another page of this browser that saw the chains in its audit has written them as seen.
if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key?.startsWith('arc.chains-seen:')) recompute(); });
/** Forgets what was read, for tests. */
export function resetChainAlerts(): void { account = undefined; recompute(); }

/** The passed chains the person has not seen. */
export const useChainAlerts = (): readonly ChainAlert[] => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => alerts);

/** Reads the chains while the page is open, at the pace of the Team roster's idle refresh and when its feed reopens: no faster poll. */
export function useChainAlertPoll({ baseUrl, enabled, client: given }: { baseUrl: string; enabled: boolean; client?: Pick<RemoteChainClient, 'list'> }): void {
  const periodMs = useContext(TeamRefresh).idleMs;
  useEffect(() => {
    if (!enabled) return;
    const client = given ?? new RemoteChainClient(baseUrl, workspaceFetch);
    let stopped = false, inFlight = false;
    const load = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try { const view = await client.list(); if (!stopped) observeChains(baseUrl, view.chains); } catch { /* the next refresh tries again */ } finally { inFlight = false; }
    };
    const unwatch = watchList(load), timer = setInterval(() => void load(), periodMs);
    return () => { stopped = true; clearInterval(timer); unwatch(); };
  }, [baseUrl, enabled, periodMs, given]);
}
