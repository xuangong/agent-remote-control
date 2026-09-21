import { act, createRef } from 'react';
import { beforeAll, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor.js';
import type { DraftPart } from './composer-document.js';

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

it('inserts image atoms at a mapped picker selection and preserves undo identity', async () => {
  const ref = createRef<ComposerEditorHandle>();
  let parts: DraftPart[] = [{ type: 'text', text: 'Before after' }];
  const change = vi.fn((value: DraftPart[]) => { parts = value; });
  const view = () => <ComposerEditor ref={ref} id="editor" parts={parts} images={{}} disabled={false} onChange={change} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />;
  const container = await render(view());
  await act(async () => { ref.current!.captureSelection(); ref.current!.insertText('prefix '); });
  await rerender(container, view());
  await act(async () => ref.current!.insertParts([{ type: 'image', imageId: 'one', label: 'image #1' }]));
  expect(parts).toEqual([{ type: 'text', text: 'prefix ' }, { type: 'image', imageId: 'one', label: 'image #1' }, { type: 'text', text: 'Before after' }]);
  expect(container.querySelector('[data-image-id="one"]')?.getAttribute('contenteditable')).toBe('false');
  const editor = container.querySelector('[role="textbox"]')!;
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })));
  expect(parts.some(part => part.type === 'image')).toBe(false);
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true })));
  expect(parts.some(part => part.type === 'image' && part.imageId === 'one')).toBe(true);
});

it('keeps pasted tag-looking text as text and ignores HTML images', async () => {
  const change = vi.fn();
  const container = await render(<ComposerEditor id="editor" parts={[]} images={{}} disabled={false} onChange={change} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />);
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? '[image #1]' : type === 'text/html' ? '<img src="https://example.test/image.png">' : '' } });
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(paste));
  expect(change).toHaveBeenCalledWith([{ type: 'text', text: '[image #1]' }]);
  expect(container.querySelector('[data-image-id]')).toBeNull();
});

it('copies and cuts a range containing image atoms and restores their identity with undo', async () => {
  let parts: DraftPart[] = [{ type: 'text', text: 'a' }, { type: 'image', imageId: 'atom', label: 'image #3' }, { type: 'text', text: 'b' }];
  const container = await render(<ComposerEditor id="editor" parts={parts} images={{}} disabled={false} onChange={value => { parts = value; }} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />);
  const editor = container.querySelector('[role="textbox"]')!;
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })));
  const data = new Map<string, string>();
  const cut = new Event('cut', { bubbles: true, cancelable: true });
  Object.defineProperty(cut, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } });
  await act(async () => editor.dispatchEvent(cut));
  expect(data.get('text/plain')).toBe('a[image #3]b');
  expect(JSON.parse(data.get('application/x-agent-remote-image-draft+json')!)[1]).toEqual({ type: 'image', imageId: 'atom', label: 'image #3' });
  expect(parts).toEqual([]);
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })));
  expect(parts[1]).toEqual({ type: 'image', imageId: 'atom', label: 'image #3' });
});

it('does not submit composition input and handles mobile line-break intent', async () => {
  const change = vi.fn(); const key = vi.fn();
  const container = await render(<ComposerEditor id="editor" parts={[]} images={{}} disabled={false} onChange={change} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={key} />);
  const editor = container.querySelector('[role="textbox"]')!;
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  expect(key).not.toHaveBeenCalled();
  await act(async () => editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })));
  expect(change).toHaveBeenCalledWith([{ type: 'text', text: '\n' }]);
});

it('pastes at the current selection after a file picker was cancelled', async () => {
  const ref = createRef<ComposerEditorHandle>();
  let parts: DraftPart[] = [{ type: 'text', text: 'Hello' }];
  const atom: DraftPart = { type: 'image', imageId: 'pasted', label: 'image #1' };
  const container = await render(<ComposerEditor ref={ref} id="editor" parts={parts} images={{}} disabled={false}
    onChange={value => { parts = value; }} onFiles={() => [atom]} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />);
  await act(async () => { ref.current!.focus(); ref.current!.captureSelection(); });
  const editor = container.querySelector('[role="textbox"]')!;
  await act(async () => {
    const selection = document.getSelection()!;
    selection.collapse(editor.firstChild!, 5);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'image.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => editor.dispatchEvent(paste));
  expect(parts).toEqual([{ type: 'text', text: 'Hello' }, atom]);
});

it('pastes restored image bytes at the mapped selection and ignores completion after remount', async () => {
  const ref = createRef<ComposerEditorHandle>();
  let finish!: (parts: DraftPart[]) => void;
  const restored = new Promise<DraftPart[]>(resolve => { finish = resolve; });
  let parts: DraftPart[] = [{ type: 'text', text: 'After' }];
  const atom: DraftPart = { type: 'image', imageId: 'restored', label: 'image #1' };
  const change = (value: DraftPart[]) => { parts = value; };
  const surface = (key: string) => <ComposerEditor key={key} ref={ref} id={key} parts={parts} images={{}} disabled={false} onChange={change}
    onFiles={() => []} onImport={() => restored} onRetry={() => {}} onKeyDown={() => {}} />;
  const container = await render(surface('first'));
  function paste() {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'application/x-agent-remote-image-draft+json' ? JSON.stringify([atom]) : '' } });
    container.querySelector('[role="textbox"]')!.dispatchEvent(event);
  }
  await act(async () => { paste(); ref.current!.insertText('Before '); });
  await act(async () => finish([atom]));
  expect(parts).toEqual([{ type: 'text', text: 'Before ' }, atom, { type: 'text', text: 'After' }]);
  const delayed = new Promise<DraftPart[]>(resolve => { finish = resolve; });
  await rerender(container, <ComposerEditor key="delayed" id="delayed" parts={[]} images={{}} disabled={false} onChange={change}
    onFiles={() => []} onImport={() => delayed} onRetry={() => {}} onKeyDown={() => {}} />);
  await act(async () => paste());
  await rerender(container, surface('new-session'));
  const before = parts;
  await act(async () => finish([atom]));
  expect(parts).toBe(before);
});
