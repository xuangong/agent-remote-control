import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FilePreview } from './FilePreview.js';
import { FilePreviewContext, type FilePreviewRequest } from './FilePreviewContext.js';

interface SelectedFile {
  request: FilePreviewRequest;
  owner: symbol;
  scope?: string;
  version: number;
}

const FileWorkspaceContext = createContext<{
  file?: SelectedFile;
  open(request: FilePreviewRequest, owner: symbol, scope?: string): void;
  close(owner?: symbol, scope?: string): void;
} | undefined>(undefined);

/** Shares one preview outlet without making conversations share a resource lifetime. */
export function FilePreviewProvider({ children, browserOpen = false, onOpenFile }: {
  readonly children: ReactNode; readonly browserOpen?: boolean; readonly onOpenFile?: () => void;
}) {
  const [file, setFile] = useState<SelectedFile>();
  const open = useCallback((request: FilePreviewRequest, owner: symbol, scope?: string) => {
    onOpenFile?.();
    const trigger = request.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    setFile(current => ({ request: { ...request,
      returnFocus: current?.owner === owner && current.scope === scope && trigger?.closest('dialog.agent-file-preview')
        ? current.request.returnFocus : trigger }, owner, scope, version: (current?.version ?? 0) + 1 }));
  }, [onOpenFile]);
  const close = useCallback((owner?: symbol, scope?: string) => {
    setFile(current => !owner || current?.owner === owner && current.scope === scope ? undefined : current);
  }, []);
  useEffect(() => { if (browserOpen) close(); }, [browserOpen, close]);
  const value = useMemo(() => ({ file: browserOpen ? undefined : file, open, close }), [file, browserOpen, open, close]);
  return <FileWorkspaceContext.Provider value={value}><FilePreviewScope>{children}</FilePreviewScope></FileWorkspaceContext.Provider>;
}

/** Retires only previews opened by this conversation when its identity changes. */
export function FilePreviewScope({ resourceScope, children }: { readonly resourceScope?: string; readonly children: ReactNode }) {
  const workspace = useContext(FileWorkspaceContext);
  const owner = useRef(Symbol('file-preview-scope')).current;
  const close = workspace?.close, openFile = workspace?.open;
  useEffect(() => () => close?.(owner, resourceScope), [close, owner, resourceScope]);
  const value = useMemo(() => openFile ? { scopeKey: resourceScope,
    open: (request: FilePreviewRequest) => openFile(request, owner, resourceScope) } : undefined, [openFile, owner, resourceScope]);
  return <FilePreviewContext.Provider value={value}>{children}</FilePreviewContext.Provider>;
}

export function useFilePreviewWorkspace() { return useContext(FileWorkspaceContext); }

/** The existing workspace owns positioning and resizing for every file origin. */
export function FilePreviewOutlet() {
  const workspace = useFilePreviewWorkspace();
  const file = workspace?.file;
  if (!file) return null;
  return <FilePreviewContext.Provider value={{ scopeKey: file.scope, open: request => workspace.open(request, file.owner, file.scope) }}>
    <FilePreview key={file.version} request={file.request} onClose={() => workspace.close(file.owner, file.scope)} />
  </FilePreviewContext.Provider>;
}
