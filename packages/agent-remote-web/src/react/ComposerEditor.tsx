import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Schema, type Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, NodeSelection, type SelectionBookmark } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { history, redo, undo } from 'prosemirror-history';
import type { DraftImage } from '../image-drafts.js';
import { normalizeDraftParts, type DraftPart } from './composer-document.js';
import { ImagePreview } from './ImagePreview.js';

const schema = new Schema({ nodes: {
  doc: { content: 'inline*' },
  text: { group: 'inline' },
  image: { inline: true, group: 'inline', atom: true, selectable: true, draggable: false,
    attrs: { imageId: {}, label: {} },
    toDOM: node => ['span', { 'data-image-id': node.attrs.imageId, class: 'agent-image-tag', contenteditable: 'false', role: 'img', 'aria-label': node.attrs.label }, `[${node.attrs.label}]`],
  },
} });
const CLIPBOARD = 'application/x-agent-remote-image-draft+json';
function toDocument(parts: readonly DraftPart[]): ProseMirrorNode {
  return schema.node('doc', null, parts.flatMap(part => part.type === 'text' ? part.text ? [schema.text(part.text)] : [] : [schema.node('image', part)]));
}
function fromDocument(doc: ProseMirrorNode): DraftPart[] {
  const parts: DraftPart[] = [];
  doc.forEach(node => { if (node.isText) parts.push({ type: 'text', text: node.text! }); else if (node.type.name === 'image') parts.push({ type: 'image', imageId: String(node.attrs.imageId), label: String(node.attrs.label) }); });
  return normalizeDraftParts(parts);
}
export interface ComposerEditorHandle { focus(): void; openImage(imageId: string): void; insertText(text: string): void; captureSelection(): void; insertParts(parts: readonly DraftPart[]): void }
interface Props {
  id: string; parts: readonly DraftPart[]; images: Readonly<Record<string, DraftImage>>; disabled: boolean;
  onChange(parts: DraftPart[]): void; onFiles(files: readonly Blob[], replacingImageId?: string): DraftPart[];
  onImport(parts: readonly DraftPart[]): DraftPart[] | Promise<DraftPart[]>; onRetry(imageId: string): void;
  onKeyDown(event: globalThis.KeyboardEvent): void;
  describedBy?: string; controls?: string; activeDescendant?: string;
}
export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const latest = useRef(props); latest.current = props;
  const bookmark = useRef<SelectionBookmark>();
  const previewSelection = useRef<SelectionBookmark>();
  const pendingPastes = useRef(new Map<object, SelectionBookmark>());
  const [selected, setSelected] = useState<string>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string>();
  function insertParts(parts: readonly DraftPart[], useCapturedSelection = false): void {
    const editor = view.current;
    if (!editor || latest.current.disabled || !parts.length) return;
    let transaction = editor.state.tr;
    if (useCapturedSelection && bookmark.current) transaction = transaction.setSelection(bookmark.current.resolve(transaction.doc));
    bookmark.current = undefined;
    transaction.replaceWith(transaction.selection.from, transaction.selection.to, toDocument(parts).content);
    editor.dispatch(transaction.scrollIntoView()); editor.focus();
  }
  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    openImage: imageId => {
      const editor = view.current;
      if (!editor) return;
      let position: number | undefined;
      editor.state.doc.forEach((node, offset) => { if (position === undefined && node.type.name === 'image' && node.attrs.imageId === imageId) position = offset; });
      if (position === undefined) return;
      editor.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)));
      previewSelection.current = editor.state.selection.getBookmark();
      editor.focus(); setPreviewOpen(true);
    },
    insertText: text => { const editor = view.current; if (editor && !latest.current.disabled && !editor.composing) { editor.dispatch(editor.state.tr.insertText(text).scrollIntoView()); editor.focus(); } },
    captureSelection: () => { bookmark.current = view.current?.state.selection.getBookmark(); }, insertParts: parts => insertParts(parts, true),
  }));
  useLayoutEffect(() => {
    if (!container.current) return;
    const editor = new EditorView(container.current, {
      state: EditorState.create({ schema, doc: toDocument(latest.current.parts), plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo, 'Shift-Enter': (state, dispatch) => { dispatch?.(state.tr.insertText('\n')); return true; } }), keymap(baseKeymap)] }),
      attributes: { id: props.id, role: 'textbox', 'aria-label': 'Message', 'aria-multiline': 'true', 'data-testid': 'prompt-input', class: 'agent-composer-editor', 'data-placeholder': 'Message…' },
      editable: () => !latest.current.disabled,
      dispatchTransaction(transaction) {
        if (bookmark.current) bookmark.current = bookmark.current.map(transaction.mapping);
        for (const [key, selection] of pendingPastes.current) pendingPastes.current.set(key, selection.map(transaction.mapping));
        if (previewSelection.current) previewSelection.current = previewSelection.current.map(transaction.mapping);
        editor.updateState(editor.state.apply(transaction));
        const selection = editor.state.selection;
        setSelected(selection instanceof NodeSelection && selection.node.type.name === 'image' ? String(selection.node.attrs.imageId) : undefined);
        if (transaction.docChanged) latest.current.onChange(fromDocument(editor.state.doc));
      },
      handleClickOn(_view, _position, node, nodePosition, _event, direct) {
        if (!direct || node.type.name !== 'image') return false;
        editor.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, nodePosition)));
        previewSelection.current = editor.state.selection.getBookmark();
        editor.focus(); setPreviewOpen(true); return true;
      },
      handleKeyDown(_view, event) {
        if (event.isComposing || editor.composing || event.keyCode === 229) return false;
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && editor.state.selection instanceof NodeSelection && editor.state.selection.node.type.name === 'image') {
          previewSelection.current = editor.state.selection.getBookmark();
          event.preventDefault(); setPreviewOpen(true); return true;
        }
        latest.current.onKeyDown(event); return event.defaultPrevented;
      },
      handlePaste(_view, event) {
        if (latest.current.disabled) return false;
        const clipboard = event.clipboardData;
        const data = clipboard?.getData(CLIPBOARD);
        if (data) {
          try {
            const value: unknown = JSON.parse(data);
            if (Array.isArray(value) && value.length <= 1000 && value.every(part => part && typeof part === 'object' && ((part.type === 'text' && typeof part.text === 'string') || (part.type === 'image' && typeof part.imageId === 'string' && typeof part.label === 'string')))) {
              const imported = latest.current.onImport(value as DraftPart[]);
              if (Array.isArray(imported)) insertParts(imported);
              else {
                const request = {};
                pendingPastes.current.set(request, editor.state.selection.getBookmark());
                void imported.then(parts => {
                  const selection = pendingPastes.current.get(request);
                  if (!parts.length || !selection || view.current !== editor || latest.current.disabled) return;
                  const transaction = editor.state.tr.setSelection(selection.resolve(editor.state.doc));
                  transaction.replaceWith(transaction.selection.from, transaction.selection.to, toDocument(parts).content);
                  editor.dispatch(transaction.scrollIntoView());
                }).finally(() => pendingPastes.current.delete(request));
              }
              return true;
            }
          } catch { /* Untrusted clipboard data falls back to plain text. */ }
        }
        const files = Array.from(clipboard?.files ?? []).filter(file => file.type.startsWith('image/'));
        if (files.length) { insertParts(latest.current.onFiles(files)); return true; }
        const text = clipboard?.getData('text/plain');
        if (text !== undefined) { editor.dispatch(editor.state.tr.insertText(text)); return true; }
        return false;
      },
      handleDOMEvents: {
        beforeinput(_view, event) {
          if (latest.current.disabled || editor.composing || event.isComposing) return false;
          if (event.inputType === 'insertLineBreak') { event.preventDefault(); editor.dispatch(editor.state.tr.insertText('\n')); return true; }
          if (event.inputType === 'insertParagraph') { event.preventDefault(); latest.current.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); return true; }
          return false;
        },
        copy(_view, event) { return copy(event, false); },
        cut(_view, event) { return copy(event, true); },
        drop(_view, event) { if (event.dataTransfer?.files.length) { event.preventDefault(); return true; } return false; },
      },
    });
    function copy(event: ClipboardEvent, cut: boolean): boolean {
      if (!event.clipboardData || editor.state.selection.empty) return false;
      const parts = fromDocument(schema.node('doc', null, editor.state.selection.content().content));
      event.clipboardData.setData(CLIPBOARD, JSON.stringify(parts));
      event.clipboardData.setData('text/plain', parts.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join(''));
      event.preventDefault(); if (cut && !latest.current.disabled) editor.dispatch(editor.state.tr.deleteSelection()); return true;
    }
    view.current = editor;
    return () => { pendingPastes.current.clear(); editor.destroy(); view.current = undefined; };
  }, []);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.setProps({ editable: () => !props.disabled });
    const doc = toDocument(props.parts);
    if (!doc.eq(editor.state.doc)) editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content).setMeta('addToHistory', false));
    for (const element of Array.from(editor.dom.querySelectorAll<HTMLElement>('[data-image-id]'))) {
      const image = props.images[element.dataset.imageId!];
      element.dataset.state = image?.status ?? 'unavailable';
      element.style.setProperty('--image-upload-progress', `${Math.round((image?.progress ?? 0) * 100)}%`);
      const label = props.parts.find(part => part.type === 'image' && part.imageId === element.dataset.imageId);
      const state = image?.status === 'uploading' ? `${Math.round(image.progress * 100)}%` : image?.status === 'ready' ? 'Ready' : image?.status ?? 'Unavailable';
      element.title = image?.error ?? `${label?.type === 'image' ? label.label : 'Image'}: ${state}`;
      element.setAttribute('aria-label', element.title);
    }
    editor.dom.setAttribute('aria-disabled', String(props.disabled));
    for (const [attribute, value] of [['aria-describedby', props.describedBy], ['aria-controls', props.controls], ['aria-activedescendant', props.activeDescendant]] as const) {
      if (value) editor.dom.setAttribute(attribute, value); else editor.dom.removeAttribute(attribute);
    }
  });
  function remove(imageId: string): void {
    const editor = view.current; if (!editor || props.disabled) return;
    let position: number | undefined = editor.state.selection instanceof NodeSelection && editor.state.selection.node.attrs.imageId === imageId ? editor.state.selection.from : undefined;
    editor.state.doc.forEach((node, offset) => { if (node.attrs.imageId === imageId && position === undefined) position = offset; });
    if (position !== undefined) editor.dispatch(editor.state.tr.delete(position, position + 1)); editor.focus();
  }
  const image = selected ? props.images[selected] : undefined;
  const selectedPart = props.parts.find(part => part.type === 'image' && part.imageId === selected);
  const imageStatus = image?.status === 'ready' ? 'Ready to send' : image?.status === 'uploading' ? `Uploading ${Math.round(image.progress * 100)}%`
    : image?.status === 'pending' ? 'Waiting to upload' : image?.status === 'failed' ? 'Upload failed' : 'Image unavailable';
  function closePreview(): void {
    setPreviewOpen(false);
    const editor = view.current;
    if (!editor) return;
    if (previewSelection.current) editor.dispatch(editor.state.tr.setSelection(previewSelection.current.resolve(editor.state.doc)));
    previewSelection.current = undefined;
    editor.focus();
  }
  return <>
    <div ref={container} className="agent-composer-editor-container" />
    {selected && previewOpen ? <ImagePreview blob={image?.blob} label={selectedPart?.type === 'image' ? selectedPart.label : 'Image'}
      status={imageStatus} error={image?.error} progress={image?.status === 'uploading' ? image.progress : undefined} onClose={closePreview} actions={<>
        <button type="button" className="agent-image-preview-remove" disabled={props.disabled} onClick={() => { setPreviewOpen(false); remove(selected); }}>Remove</button>
        <button type="button" disabled={props.disabled} onClick={() => { replacing.current = selected; bookmark.current = view.current?.state.selection.getBookmark(); replaceInput.current?.click(); }}>Replace</button>
        {image?.status === 'failed' ? <button type="button" className="agent-image-preview-retry" disabled={props.disabled || !image.blob} onClick={() => props.onRetry(selected)}>Retry</button> : null}
      </>} /> : null}
    <input ref={replaceInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
      if (files.length && replacing.current) { setPreviewOpen(false); insertParts(props.onFiles(files, replacing.current), true); } replacing.current = undefined;
    }} />
  </>;
});
