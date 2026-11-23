import { describe, expect, it } from 'vitest';
import { SETTINGS_GROUP_IDS } from '../../kernel/destinations.js';
import { computerItems, settingsGroups, type SettingsFacts, type SettingsItemId } from './settings-groups.js';

const everyFacts: SettingsFacts[] = [false, true].flatMap(account => [false, true].map(notificationsAvailable => ({ account, notificationsAvailable })));

describe('the Settings groups', () => {
  it.each([
    [{ account: true, notificationsAvailable: true }, {
      general: ['theme', 'language', 'motion', 'defaultView', 'mobileDisplay'], assistants: ['processMode', 'notifications', 'push', 'letters', 'audit'],
      computers: ['computers', 'pairing'], privacy: ['cache'], advanced: ['layoutDiagnostics', 'trace', 'inspector'],
      account: ['account', 'security', 'signOut', 'versions'] }],
    [{ account: false, notificationsAvailable: false }, {
      general: ['theme', 'language', 'motion', 'defaultView', 'mobileDisplay'], assistants: ['processMode', 'push', 'letters', 'audit'],
      computers: ['computers', 'pairing'], privacy: ['cache'], advanced: ['layoutDiagnostics', 'trace', 'inspector'], account: ['versions'] }],
  ] as const)('%j', (facts, groups) => {
    expect(Object.fromEntries(settingsGroups(facts).map(group => [group.id, group.items]))).toEqual(groups);
  });

  it('keeps the six groups in order, whatever the reader may do', () => {
    for (const facts of everyFacts) expect(settingsGroups(facts).map(group => group.id)).toEqual(SETTINGS_GROUP_IDS);
  });

  it('gives every setting exactly one home', () => {
    const homes = new Map<SettingsItemId, Set<string>>();
    for (const facts of everyFacts) for (const group of settingsGroups(facts)) for (const item of group.items) {
      homes.set(item, (homes.get(item) ?? new Set()).add(group.id));
      expect(group.items.filter(other => other === item), item).toHaveLength(1);
    }
    for (const [item, groups] of homes) expect([...groups], item).toHaveLength(1);
  });

  it('shows a computer\'s owner its updates, smart reading and keys, and anyone its agents, previews and tunnel', () => {
    expect(computerItems({ owned: true })).toEqual(['agents', 'previews', 'vscodeTunnel', 'controllerUpdates', 'smartReading', 'hostSecurity']);
    expect(computerItems({ owned: false })).toEqual(['agents', 'previews', 'vscodeTunnel']);
  });
});
