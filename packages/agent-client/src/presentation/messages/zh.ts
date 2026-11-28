/** Every Chinese word of the catalogue, merged from its areas; each area is typed by its English one. */
import type { Message } from './types.js';
import type { MessageKey } from './en.js';
import { common } from './areas/common.zh.js';
import { conversation } from './areas/conversation.zh.js';
import { composer } from './areas/composer.zh.js';
import { timeline } from './areas/timeline.zh.js';
import { navigation } from './areas/navigation.zh.js';
import { settings } from './areas/settings.zh.js';
import { hosts } from './areas/hosts.zh.js';
import { windows } from './areas/windows.zh.js';
import { sessions } from './areas/sessions.zh.js';
import { team } from './areas/team.zh.js';
import { diagnostics } from './areas/diagnostics.zh.js';
import { client } from './areas/client.zh.js';
import { push } from './areas/push.zh.js';
import { routines } from './areas/routines.zh.js';

/** The Chinese areas by name, for the catalogue's own checks. */
export const chineseAreas = { common, conversation, composer, timeline, navigation, settings, hosts, windows, sessions, team, diagnostics, client, push, routines } as const;
export const zh: Readonly<Record<MessageKey, Message>> = { ...common, ...conversation, ...composer, ...timeline, ...navigation, ...settings, ...hosts, ...windows, ...sessions, ...team, ...diagnostics, ...client, ...push, ...routines };
