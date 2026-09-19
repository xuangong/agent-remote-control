import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ClaudeImageRegistry } from './images.js';
import { ClaudeEventProjector } from './projector.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
const frame = { type: 'user', uuid: 'result', session_id: 'session', message: { content: [
  { type: 'tool_result', tool_use_id: 'read', content: [{ type: 'text', text: 'Native image' }, image] },
] } };

it('owns immutable native image bytes with stable references scoped to the native session', async () => {
  const registry = new ClaudeImageRegistry('session');
  const first = registry.project('read', 1, image)!;
  const locator = first.resourceReferences[0]!.locator;
  expect(locator).toMatch(/^claude-image:[a-f0-9]{64}$/);
  expect(first.item.text).toBe(`![Tool image](${locator})`);
  first.resourceReferences[0]!.locator = 'mutated';
  expect(registry.project('read', 1, image)!.resourceReferences[0]!.locator).toBe(locator);
  const result = await registry.readResource(locator);
  expect(result).toMatchObject({ status: 'available', mediaType: 'image/png' });
  if (result.status !== 'available') throw new Error('Missing image');
  expect(Buffer.from(result.bytes)).toEqual(Buffer.from(png, 'base64'));
  result.bytes.fill(0);
  expect(await registry.readResource(locator)).toMatchObject({ bytes: Buffer.from(png, 'base64') });
  expect(new ClaudeImageRegistry('other').project('read', 1, image)!.resourceReferences[0]!.locator).not.toBe(locator);
  for (const invalid of [locator + 'x', '/tmp/pixel.png', 'https://example.test/image.png']) {
    expect(await registry.readResource(invalid)).toMatchObject({ status: 'unavailable' });
  }
  expect(await new ClaudeImageRegistry('other').readResource(locator)).toMatchObject({ status: 'unavailable' });
  registry.stop();
  expect(await registry.readResource(locator)).toMatchObject({ status: 'unavailable' });
  expect(registry.project('read', 1, image)).toBeNull();
});

it('rejects malformed, non-raster, mismatched, path, and remote image sources', () => {
  const registry = new ClaudeImageRegistry('session');
  for (const source of [
    { type: 'url', url: 'https://example.test/image.png' }, { type: 'file', path: '/tmp/pixel.png' },
    { ...image.source, data: '<svg />' }, { ...image.source, data: Buffer.from('<html>hello</html>').toString('base64') },
    { ...image.source, data: png + '=' }, { ...image.source, media_type: 'image/jpeg' },
  ]) {
    const projection = registry.project('read', 0, { type: 'image', source })!;
    expect(projection.resourceReferences).toEqual([]);
    expect(projection.item.text).toMatch(/unavailable/);
  }
  expect(registry.project('', 0, image)).toBeNull();
  expect(registry.project('read', 0, { type: 'text', text: png })).toBeNull();
});

it('bounds individual bytes, total retained bytes, and image count without charging replay twice', async () => {
  const bytes = Buffer.from(png, 'base64').length;
  const small = new ClaudeImageRegistry('session', { maxImageBytes: bytes - 1 });
  expect(small.project('large', 0, image)!.resourceReferences).toEqual([]);
  const registry = new ClaudeImageRegistry('session', { maxSessionImageBytes: bytes * 2, maxImages: 3 });
  const first = registry.project('one', 0, image)!;
  expect(registry.project('one', 0, image)).toEqual(first);
  expect(registry.project('two', 0, image)!.resourceReferences).toHaveLength(1);
  expect(registry.project('three', 0, image)!.resourceReferences).toEqual([]);
  expect(await registry.readResource(first.resourceReferences[0]!.locator)).toMatchObject({ status: 'available' });
  const counted = new ClaudeImageRegistry('session', { maxImages: 1 });
  counted.project('one', 0, image);
  expect(counted.project('two', 0, image)!.resourceReferences).toEqual([]);
});

it('preserves the first bytes for repeated native image identity', async () => {
  const registry = new ClaudeImageRegistry('session');
  const first = registry.project('read', 0, image)!;
  const changed = { ...image, source: { ...image.source, data: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('changed')]).toString('base64') } };
  expect(registry.project('read', 0, changed)).toEqual(first);
  expect(await registry.readResource(first.resourceReferences[0]!.locator)).toMatchObject({ bytes: Buffer.from(png, 'base64') });
});

it('projects native tool images once with linked resources and stable history replay', () => {
  const registry = new ClaudeImageRegistry('session');
  const live = new ClaudeEventProjector('session', 'live', registry);
  const observations = live.project(frame);
  expect(observations[0]!.event).toMatchObject({ item: { type: 'tool_call', callId: 'read', result: { content: [{ type: 'text', text: 'Native image' }] } } });
  expect(observations[1]).toMatchObject({ resourceReferences: [{ locator: expect.stringMatching(/^claude-image:/), readLocator: expect.stringMatching(/^claude-image:/) }],
    event: { item: { type: 'assistant_message', text: expect.stringMatching(/^!\[Tool image\]/) } } });
  expect(live.project(frame)).toEqual([]);
  const replay = new ClaudeEventProjector('session', 'history', registry).project(frame);
  expect(replay.map(({ sourceKey, event, resourceReferences }) => ({ sourceKey, event, resourceReferences })))
    .toEqual(observations.map(({ sourceKey, event, resourceReferences }) => ({ sourceKey, event, resourceReferences })));
  expect(new ClaudeEventProjector('session', 'live', registry).project({ ...frame, parent_tool_use_id: 'child' })).toEqual([]);
});

it('keeps native image metadata in tool results while retaining arbitrary user JSON unchanged', () => {
  const registry = new ClaudeImageRegistry('session');
  const nativeImage = { type: 'image', file: { base64: png, type: 'image/png', originalSize: 68, dimensions: { width: 1, height: 1 } } };
  const projected = new ClaudeEventProjector('session', 'live', registry).project({ ...frame, tool_use_result: nativeImage });
  expect(projected[0]!.event).toMatchObject({ item: { result: { content: [
    { type: 'text', text: 'Native image' },
    { type: 'json', value: { type: 'image', file: { type: 'image/png', originalSize: 68, dimensions: { width: 1, height: 1 } } } },
  ] } } });
  expect(JSON.stringify(projected)).not.toContain(png);
  const arbitrary = { base64: 'User data', nested: { base64: 'Other data' } };
  const ordinary = new ClaudeEventProjector('session').project({ ...frame, tool_use_result: arbitrary });
  expect(ordinary[0]!.event).toMatchObject({ item: { result: { content: expect.arrayContaining([{ type: 'json', value: arbitrary }]) } } });
});

it('replays ordered native user images with digests and readable resources from a fresh registry', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
  const secondBytes = Buffer.from([255, 216, 255, 224]);
  const registry = new ClaudeImageRegistry('session');
  const blocks = [{ type: 'text', text: 'before ' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
    { type: 'text', text: ' between ' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: secondBytes.toString('base64') } }, { type: 'text', text: ' after' }];
  const project = (content: unknown[], id: string) => new ClaudeEventProjector('session', 'history', registry).project({ uuid: id, type: 'user', message: { content } })[0];
  const observation = project(blocks, 'user-one')!;
  const item = observation.event.type === 'timeline' ? observation.event.item : undefined;
  expect(item).toMatchObject({ type: 'user_message', messageId: 'user-one', text: 'before [image #1] between [image #2] after' });
  if (item?.type !== 'user_message') throw new Error('Missing user message');
  expect(item.content?.map(part => part.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
  expect(item.content?.[1]).toMatchObject({ sha256: createHash('sha256').update(bytes).digest('hex') });
  expect(item.content?.[3]).toMatchObject({ sha256: createHash('sha256').update(secondBytes).digest('hex') });
  expect(observation.resourceReferences).toHaveLength(2);
  for (const [index, reference] of observation.resourceReferences!.entries()) expect(await registry.readResource(reference.readLocator))
    .toMatchObject({ status: 'available', bytes: index === 0 ? bytes : secondBytes });
  expect(project([blocks[1]], 'image-only')?.event).toMatchObject({ item: { type: 'user_message', content: [{ type: 'image' }] } });
});
