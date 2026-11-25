// @vitest-environment jsdom
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

it('reads the paragraph input that follows a Shift+Enter as a line break, not as Enter', async () => {
  // iPhone WebKit reports Shift+Enter as keydown with shift, then beforeinput insertParagraph without it.
  const change = vi.fn(); const key = vi.fn();
  const container = await render(<ComposerEditor id="editor" parts={[]} images={{}} disabled={false} onChange={change} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={key} />);
  const editor = container.querySelector('[role="textbox"]')!;
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })));
  key.mockClear();
  await act(async () => editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })));
  expect(change).toHaveBeenCalledWith([{ type: 'text', text: '\n' }]);
  expect(key).not.toHaveBeenCalled();
  // The next paragraph input, with no Shift+Enter before it, is still Enter.
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })));
  await act(async () => editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })));
  expect(key).toHaveBeenCalledTimes(1);
  expect(key.mock.calls[0]![0]).toMatchObject({ key: 'Enter' });
});

it('does not send the Enter that ProseMirror replays on iOS after a Shift+Enter', async () => {
  vi.useFakeTimers();
  try {
    const key = vi.fn();
    const container = await render(<ComposerEditor id="editor" parts={[]} images={{}} disabled={false} onChange={() => {}} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={key} />);
    const editor = container.querySelector('[role="textbox"]')!;
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })));
    key.mockClear();
    // The replay is an untrusted event without Shift. Dispatching one is the same: jsdom marks it untrusted too.
    vi.advanceTimersByTime(200);
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(key).not.toHaveBeenCalled();
    // Much later the same event is an Enter again.
    vi.advanceTimersByTime(1000);
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(key).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
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

it('preserves pasted newlines and blank lines when subsequent native typing updates the DOM', async () => {
  let parts: DraftPart[] = [];
  const container = await render(<ComposerEditor id="editor" parts={[]} images={{}} disabled={false}
    onChange={value => { parts = value; }} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />);
  const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
  const text = 'Previews\nWork Mac\n\nRefresh\n  No active previews.';
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? text : '' } });
  await act(async () => { editor.focus(); editor.dispatchEvent(paste); });
  expect(parts).toEqual([{ type: 'text', text }]);
  // Native typing and IME mutate the editable DOM before ProseMirror reads it back.
  await act(async () => {
    editor.firstChild!.nodeValue = text + ' More';
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(parts).toEqual([{ type: 'text', text: text + ' More' }]);
});

it('synchronizes a retained draft without reporting another user edit', async () => {
  const change = vi.fn();
  const view = (text: string) => <ComposerEditor id="retained" parts={[{ type: 'text', text }]} images={{}} disabled={false} onChange={change} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />;
  const container = await render(view('before'));
  await rerender(container, view('restored prompt'));
  expect(container.querySelector('[role="textbox"]')?.textContent).toBe('restored prompt');
  expect(change).not.toHaveBeenCalled();
  const input = container.querySelector('[role="textbox"]')!;
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })));
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? 'new draft' : '' } });
  await act(async () => input.dispatchEvent(paste));
  expect(change).toHaveBeenCalledWith([{ type: 'text', text: 'new draft' }]);
});

it('reads the paragraph input as a line break under a coarse pointer', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
  try {
    const change = vi.fn();
    const container = await render(<ComposerEditor id="editor" parts={[]} images={{}} disabled={false} onChange={change} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />);
    const editor = container.querySelector('[role="textbox"]')!;
    await act(async () => editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })));
    expect(change).toHaveBeenCalledWith([{ type: 'text', text: '\n' }]);
  } finally { vi.unstubAllGlobals(); }
});

it('hides the placeholder while the draft holds text, and shows it for an empty draft', async () => {
  const view = (parts: DraftPart[]) => <ComposerEditor id="editor" parts={parts} images={{}} disabled={false} placeholder="Message Peach…" onChange={() => {}} onFiles={() => []} onImport={value => [...value]} onRetry={() => {}} onKeyDown={() => {}} />;
  const container = await render(view([]));
  const editor = container.querySelector('[role="textbox"]')!;
  expect(editor.hasAttribute('data-empty')).toBe(true);
  await rerender(container, view([{ type: 'text', text: 'hello' }]));
  expect(editor.hasAttribute('data-empty')).toBe(false);
  await rerender(container, view([{ type: 'text', text: 'a' }, { type: 'image', imageId: 'one', label: 'image #1' }]));
  expect(editor.hasAttribute('data-empty')).toBe(false);
  await rerender(container, view([]));
  expect(editor.hasAttribute('data-empty')).toBe(true);
});
