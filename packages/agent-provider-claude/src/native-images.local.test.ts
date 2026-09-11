import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';
import { createClaudeCatalog } from '../dist/catalog.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';

it('exposes original embedded image bytes in public native Read tool results', async () => {
  let calls = 0;
  const fixture = await nativeFixture((_body, response) => nativeReply(response, ++calls === 1
    ? [{ type: 'tool_use', id: 'read-image', name: 'Read', input: { file_path: join(fixture.cwd, 'pixel.png') } }]
    : [{ type: 'text', text: 'IMAGE_OK' }]));
  await writeFile(join(fixture.cwd, 'pixel.png'), Buffer.from(png, 'base64'));
  const frames: any[] = [];
  const config = { sessionId: randomUUID(), cwd: fixture.cwd };
  const session = await ClaudeAgentSession.open(config, {
    ...fixture.options, query: (args) => {
      const native = query(args);
      return new Proxy(native, { get(target, key) {
        if (key === Symbol.asyncIterator) return async function* () { for await (const frame of target) { frames.push(frame); yield frame; } };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  });
  const observations: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') observations.push(item); })();
  try {
    await session.sendMessage('Read pixel.png');
    await expect.poll(() => observations.some((item) => item.event.type === 'turn_completed')).toBe(true);
    const result = frames.find((frame) => frame.type === 'user' && Array.isArray(frame.message?.content)
      && frame.message.content.some((block: any) => block.type === 'tool_result' && block.tool_use_id === 'read-image'));
    const tool = result?.message.content.find((block: any) => block.type === 'tool_result');
    expect(tool).toBeDefined();
    expect(tool.content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
    const rendered = observations.find((item) => item.resourceReferences?.length);
    expect(rendered).toBeDefined();
    expect(JSON.stringify(observations)).not.toContain(png);
    const locator = rendered.resourceReferences[0].readLocator;
    expect(await session.readResource(locator)).toMatchObject({ status: 'available', mediaType: 'image/png', bytes: Buffer.from(png, 'base64') });
    await session.dispose(); await pump;
    expect(await session.readResource(locator)).toMatchObject({ status: 'unavailable' });
    const catalog = createClaudeCatalog(fixture.options.env, 5000);
    const messages = await catalog.messages(config.sessionId);
    const resumed = await ClaudeAgentSession.open(config, { ...fixture.options, catalog }, messages, true);
    try {
      const history: any[] = [];
      for await (const item of resumed.observe()) { if (item.type === 'history_boundary') break; history.push(item); }
      expect(JSON.stringify(history)).not.toContain(png);
      expect(history.find((item) => item.resourceReferences?.length)?.resourceReferences).toEqual(rendered.resourceReferences);
      expect(await resumed.readResource(locator)).toMatchObject({ status: 'available', mediaType: 'image/png', bytes: Buffer.from(png, 'base64') });
    } finally { await resumed.dispose(); }
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 10000);
