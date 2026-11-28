/**
 * The Settings page (design "Navigation and Settings"): six groups in a fixed order, the items each holds for this reader, and the
 * items of each computer. Every setting has exactly one home: an item belongs to one group, and an assistant's own name, avatar
 * and process mode stay in its details. Pure: the page passes what it knows in.
 */
import type { SettingsGroupId } from '../../kernel/destinations.js';

export type SettingsItemId =
  | 'theme' | 'language' | 'motion' | 'defaultView' | 'mobileDisplay'
  | 'processMode' | 'notifications' | 'push' | 'letters' | 'unattended' | 'audit'
  | 'computers' | 'pairing'
  | 'cache'
  | 'layoutDiagnostics' | 'trace' | 'inspector'
  | 'account' | 'security' | 'signOut' | 'versions';
/** What a computer's page holds: its agents, its previews and VS Code tunnel, and for its owner its updates, smart reading and its keys. */
export type ComputerItemId = 'agents' | 'previews' | 'vscodeTunnel' | 'controllerUpdates' | 'smartReading' | 'hostSecurity';

export interface SettingsFacts {
  /** Signed in through the gateway, as an account that can sign out. */
  readonly account: boolean;
  /** This device can show desktop notifications (not a phone). */
  readonly notificationsAvailable: boolean;
}
export interface ComputerFacts { readonly owned: boolean }
export interface SettingsGroup { readonly id: SettingsGroupId; readonly items: readonly SettingsItemId[] }

export function settingsGroups(facts: SettingsFacts): readonly SettingsGroup[] {
  return [
    { id: 'general', items: ['theme', 'language', 'motion', 'defaultView', 'mobileDisplay'] },
    // Push has a row on every device: where it does not work, the row says why.
    // The audit of what the bots did, beside what all assistants share (bots design 7).
    { id: 'assistants', items: ['processMode', ...(facts.notificationsAvailable ? ['notifications' as const] : []), 'push', 'letters', 'unattended', 'audit'] },
    { id: 'computers', items: ['computers', 'pairing'] },
    { id: 'privacy', items: ['cache'] },
    { id: 'advanced', items: ['layoutDiagnostics', 'trace', 'inspector'] },
    { id: 'account', items: [...(facts.account ? ['account', 'security', 'signOut'] as const : []), 'versions'] },
  ];
}

/** A computer's items: everyone sees its agents, previews and tunnel; only its owner changes its Controller, smart reading and keys. */
export function computerItems({ owned }: ComputerFacts): readonly ComputerItemId[] {
  return ['agents', 'previews', 'vscodeTunnel', ...(owned ? ['controllerUpdates', 'smartReading', 'hostSecurity'] as const : [])];
}
