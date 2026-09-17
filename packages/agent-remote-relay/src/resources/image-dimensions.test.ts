import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ResourceIngestor } from './resource-ingestor.js';
import { InMemoryResourceStore } from './resource-store.js';
import { readImageDimensions } from './image-dimensions.js';

it.each([
  ['dimensions.png', 'image/png', 40, 20],
  ['dimensions.gif', 'image/gif', 40, 20],
  ['dimensions.webp', 'image/webp', 40, 20],
  ['rotated.jpg', 'image/jpeg', 20, 40],
] as const)('delivers oriented dimensions for %s before transferring the image', async (file, mediaType, width, height) => {
  const bytes = readFileSync(new URL(`./fixtures/${file}`, import.meta.url));
  const ingestor = new ResourceIngestor({ store: new InMemoryResourceStore() });
  const acquired = ingestor.acquire({ agentId: 'agent', locator: file,
    reader: async () => ({ status: 'available', bytes, mediaType }) })!;
  const binding = await acquired.settled;
  const metadata = ingestor.readState('agent', binding.resourceId);
  expect(metadata).toMatchObject({ status: 'available', imageDimensions: { width, height } });
  expect(metadata).not.toHaveProperty('contentBase64');
  expect(ingestor.readResponse('read', 'agent', binding.resourceId).payload.state)
    .toMatchObject({ imageDimensions: { width, height }, contentBase64: bytes.toString('base64') });
});

it('tolerates truncated image headers and does not parse active image formats', () => {
  const png = readFileSync(new URL('./fixtures/dimensions.png', import.meta.url));
  for (let length = 0; length < 24; length++) {
    expect(readImageDimensions(png.subarray(0, length), 'image/png')).toBeUndefined();
  }
  expect(readImageDimensions(Buffer.from('<svg width="40" height="20"/>'), 'image/svg+xml')).toBeUndefined();
  expect(readImageDimensions(Buffer.from('plain text'), 'text/plain')).toBeUndefined();
});
