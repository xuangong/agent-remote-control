/**
 * Where files dropped on the composer go (I5d), by the same availability the "+" menu shows (composer-menu.ts). Pure: the composer
 * passes the files and its menu.
 *
 * - An image the editor takes (PNG, JPEG or WebP) joins the draft as the menu's Images adds it, when that item can be used.
 * - Any other file, and an image when images cannot be added, is a file of the message when the session takes files now.
 * - The rest is refused, said once: with the note of the item that would have taken it when it has one, "only images" when the
 *   session takes images but no files, "not now" when the session takes them but not at this moment, and otherwise "this
 *   conversation takes no files".
 */
import type { MessageKey } from '@orchardworks/agent-client';
import type { ComposerMenuItem } from './composer-menu.js';

export const COMPOSER_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

export interface DroppedFile { readonly type: string }
export interface ComposerDropPlan<F extends DroppedFile> {
  readonly images: readonly F[]; readonly resources: readonly F[]; readonly refused: readonly F[];
  /** Why files were refused, in the reader's words. */
  readonly note?: MessageKey;
}

export function planComposerDrop<F extends DroppedFile>(files: readonly F[], menu: readonly ComposerMenuItem[]): ComposerDropPlan<F> {
  const image = menu.find(item => item.id === 'image'), resource = menu.find(item => item.id === 'resource');
  const images: F[] = [], resources: F[] = [], refused: F[] = [];
  for (const file of files) {
    if (image?.enabled && COMPOSER_IMAGE_TYPES.includes(file.type)) images.push(file);
    else if (resource?.enabled) resources.push(file);
    else refused.push(file);
  }
  if (!refused.length) return { images, resources, refused };
  const anImage = refused.some(file => COMPOSER_IMAGE_TYPES.includes(file.type));
  const taker = anImage && image ? image : resource ?? image;
  const note: MessageKey = taker?.note ? taker.note
    : taker && !taker.enabled ? 'composer.dropNotNow'
    : image && !resource ? 'composer.dropImagesOnly'
    : 'composer.dropUnavailable';
  return { images, resources, refused, note };
}
