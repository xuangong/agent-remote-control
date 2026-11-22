// A bot's avatar, as the roster, a dock, a tile and a conversation all draw it.
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import type { AvatarMood } from '@orchardworks/agent-client-web/theme';

/** A bot's avatar: generated from its view id, which survives a handoff, unless its stored picture overrides it. */
export function BotPicture({ id, picture, size = 26, mood = 'idle' }: Pick<WindowBotDetails, 'picture'> & { id: string; size?: number; mood?: AvatarMood }) {
  return <AssistantAvatar id={id} {...(picture ? { picture } : {})} size={size} mood={mood} />;
}
