/** Computers: Hosts, pairing, Controller updates, agents, smart reading, the VS Code tunnel and previews. */
import type { Message } from '../types.js';

export const hosts = {
  'hosts.sessionNoun': { one: 'session', other: 'sessions' },
  'hosts.sessionsWorking': '{count} working',
  'hosts.sessionsNeedYou': '{count} needs you',
  'hosts.sessionsIdle': '{count} idle',
  'hosts.sessionsFailed': '{count} failed',
  'hosts.cores': { one: '{count} core', other: '{count} cores' },
  'hosts.memory': 'Memory',
  'hosts.home': 'Home',
  'hosts.disk': '{name} disk',
  'hosts.updateSharedOwner': 'Update required: the owner must update this Controller before its sessions open.',
  'hosts.updateDsh': 'Update required: this Host cannot send or open sessions from here until its DSH agent-remote plugin is updated on that machine.',
  'hosts.updateControllerBefore': 'Update required: this Controller cannot send or open sessions from here until it is updated. Use Update, or on that machine run ',
  'hosts.updateControllerAfter': ' and follow it.',
  'hosts.updateAction': 'Update',
  'hosts.sharedNeedsUpdate': 'Sessions show once the owner updates the Controller.',
  'hosts.needsUpdateToSee': 'Update the Controller to see CPU, memory and disks.',
  'hosts.sharedSessionsOnly': 'Shared with you: sessions only.',
  'hosts.statusUnavailable': 'Status unavailable.',
  'hosts.empty': 'No Hosts paired yet. Pair a Host to see it here.',
} as const satisfies Readonly<Record<string, Message>>;
