import { describe, expect, it } from 'vitest';
import type { ComposerMenuItem } from './composer-menu.js';
import { planComposerDrop } from './composer-drop.js';

const png = { name: 'shot.png', type: 'image/png' }, jpeg = { name: 'photo.jpg', type: 'image/jpeg' }, gif = { name: 'loop.gif', type: 'image/gif' };
const pdf = { name: 'spec.pdf', type: 'application/pdf' }, untyped = { name: 'notes', type: '' };
const images = (enabled: boolean, note?: ComposerMenuItem['note']): ComposerMenuItem => ({ id: 'image', enabled, ...(note ? { note } : {}) });
const files = (enabled: boolean, note?: ComposerMenuItem['note']): ComposerMenuItem => ({ id: 'resource', enabled, ...(note ? { note } : {}) });
const names = (list: readonly { name: string }[]) => list.map(file => file.name);

describe('planComposerDrop', () => {
  it.each([
    { name: 'images and files both taken: an editor image joins the draft, the rest are files', menu: [images(true), files(true)], dropped: [png, pdf, gif, jpeg],
      plan: { images: ['shot.png', 'photo.jpg'], resources: ['spec.pdf', 'loop.gif'], refused: [] } },
    { name: 'images only: a file is refused as images only', menu: [images(true)], dropped: [png, pdf],
      plan: { images: ['shot.png'], resources: [], refused: ['spec.pdf'], note: 'composer.dropImagesOnly' } },
    { name: 'images only: a GIF is no image the editor takes', menu: [images(true)], dropped: [gif],
      plan: { images: [], resources: [], refused: ['loop.gif'], note: 'composer.dropImagesOnly' } },
    { name: 'files only: an image is a file too', menu: [files(true)], dropped: [png, untyped],
      plan: { images: [], resources: ['shot.png', 'notes'], refused: [] } },
    { name: 'neither: everything is refused', menu: [], dropped: [png, pdf],
      plan: { images: [], resources: [], refused: ['shot.png', 'spec.pdf'], note: 'composer.dropUnavailable' } },
    { name: 'images not now (a send in flight)', menu: [images(false)], dropped: [png],
      plan: { images: [], resources: [], refused: ['shot.png'], note: 'composer.dropNotNow' } },
    { name: 'images after the history: the item\'s own note', menu: [images(false, 'composer.imagesAfterHistory'), files(false, 'composer.resourcesAfterHistory')], dropped: [png],
      plan: { images: [], resources: [], refused: ['shot.png'], note: 'composer.imagesAfterHistory' } },
    { name: 'files not ready yet while images are', menu: [images(true), files(false)], dropped: [png, pdf],
      plan: { images: ['shot.png'], resources: [], refused: ['spec.pdf'], note: 'composer.dropNotNow' } },
    { name: 'nothing dropped', menu: [images(true), files(true)], dropped: [],
      plan: { images: [], resources: [], refused: [] } },
  ])('$name', ({ menu, dropped, plan }) => {
    const result = planComposerDrop(dropped, menu);
    expect({ images: names(result.images), resources: names(result.resources), refused: names(result.refused), ...(result.note ? { note: result.note } : {}) }).toEqual(plan);
  });
});
