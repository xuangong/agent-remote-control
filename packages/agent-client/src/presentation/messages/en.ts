/** Every English word of the catalogue, merged from its areas. Keys are prefixed by area, and no key is in two areas (messages.test.ts). */
import { common } from './areas/common.en.js';
import { conversation } from './areas/conversation.en.js';
import { composer } from './areas/composer.en.js';
import { timeline } from './areas/timeline.en.js';
import { navigation } from './areas/navigation.en.js';
import { settings } from './areas/settings.en.js';
import { hosts } from './areas/hosts.en.js';
import { windows } from './areas/windows.en.js';
import { sessions } from './areas/sessions.en.js';
import { team } from './areas/team.en.js';
import { diagnostics } from './areas/diagnostics.en.js';
import { client } from './areas/client.en.js';

/** The English areas by name, for the catalogue's own checks. */
export const englishAreas = { common, conversation, composer, timeline, navigation, settings, hosts, windows, sessions, team, diagnostics, client } as const;
export const en = { ...common, ...conversation, ...composer, ...timeline, ...navigation, ...settings, ...hosts, ...windows, ...sessions, ...team, ...diagnostics, ...client } as const;
export type MessageKey = keyof typeof en;
