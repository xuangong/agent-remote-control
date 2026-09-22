import { expect, it } from 'vitest';
import { CodexEventProjector } from './projector.js';
import { codexMessageInput } from './message-content.js';

const image = { type: 'image', path: '/managed/image.png', mediaType: 'image/png', sha256: 'a'.repeat(64), label: 'image #3' } as const;
function project(content: unknown[]) {
  const observation = new CodexEventProjector('session').projectHistoryItem({ id: 'message', type: 'userMessage', content });
  if (observation?.event.type !== 'timeline') throw new Error('Missing timeline');
  return observation.event.item;
}
it('persists a plain-text image label in its original position for native clients', () => {
  const input = codexMessageInput([{ type: 'text', text: '前 ' }, image, { type: 'text', text: ' 后' }]);
  expect(input.filter(part => part.type === 'text').map(part => part.text).join('')).toBe('前 [image #3] 后');
  expect(project(input)).toMatchObject({ text: '前 [image #3] 后', content: [
    { type: 'text', text: '前 ' }, { type: 'image', label: 'image #3' }, { type: 'text', text: ' 后' },
  ] });
});
it('keeps manually typed label text and legacy image-only input', () => {
  expect(project([{ type: 'text', text: '[image #1]' }, { type: 'localImage', path: image.path }]))
    .toMatchObject({ text: '[image #1][image #1]' });
  expect(project([{ type: 'localImage', path: image.path }])).toMatchObject({ text: '[image #1]' });
});
it('uses UTF-8 byte ranges for native placeholders', () => {
  const input = codexMessageInput([{ ...image, label: '图片 #1' }]);
  expect(input[0]).toEqual({ type: 'text', text: '[图片 #1]', text_elements: [{ byteRange: { start: 0, end: 11 }, placeholder: '[图片 #1]' }] });
  expect(project(input)).toMatchObject({ text: '[图片 #1]', content: [{ type: 'image', label: '图片 #1' }] });
});
it('does not hide unrelated, malformed or orphan native text elements', () => {
  const marker = { type: 'text', text: '[image #1]', text_elements: [{ byteRange: { start: 0, end: 9 }, placeholder: '[image #1]' }] };
  expect(project([marker, { type: 'localImage', path: image.path }])).toMatchObject({ text: '[image #1][image #1]' });
  expect(project([{ ...marker, text_elements: [{ byteRange: { start: 0, end: 10 }, placeholder: '[image #1]' }] }]))
    .toMatchObject({ text: '[image #1]' });
});
