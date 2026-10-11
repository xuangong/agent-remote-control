import type { NativeAssistant, NativeMessage, NativeTool } from '../v2-native.js';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZcAAAAASUVORK5CYII=', 'base64');
export const patch = '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n';
export function assistant(id = 'msg_a', content: NativeAssistant['content'] = []): NativeAssistant {
  return { id, type: 'assistant', agent: 'build', model: { id: 'model', providerID: 'test' }, time: { created: 100, completed: 200 }, content,
    cost: 0.25, tokens: { input: 20, output: 3, reasoning: 2, cache: { read: 10, write: 5 } } };
}
export function tool(name: string, metadata: NonNullable<Extract<NativeTool['state'], { status: 'completed' }>['metadata']> = {}, input: Extract<NativeTool['state'], { status: 'completed' }>['input'] = {}): NativeTool {
  return { type: 'tool', id: 'call_1', name, time: { created: 105, ran: 110, completed: 150 },
    state: { status: 'completed', input, metadata, content: [{ type: 'text', text: 'Native output' }] } };
}

/** Wire shapes from OpenCode v2.0.25 Session.Message.Info; values are isolated test data. */
export const history = [
  { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'Inspect this image', files: [{ data: png.toString('base64'), mime: 'image/png', source: { type: 'inline' }, name: 'Pixel' }] },
  assistant('msg_first', [
    { type: 'reasoning', text: 'Inspecting the image', time: { created: 101, completed: 102 } },
    { type: 'text', text: 'I will inspect it.' },
    tool('read', {}, { path: '/work/pixel.png' }),
  ]),
  { id: 'msg_steer', type: 'user', time: { created: 210 }, text: 'Also report its dimensions' },
  { ...assistant('msg_second', [{ type: 'text', text: 'It is one pixel square.' }]), time: { created: 220, completed: 290 } },
  { id: 'msg_idle', type: 'idle', time: { created: 300 }, outcome: 'succeeded' },
  { id: 'msg_context', type: 'synthetic', time: { created: 301 }, text: 'Background command completed' },
  { id: 'msg_next', type: 'user', time: { created: 302 }, text: 'Continue' },
] satisfies NativeMessage[];
