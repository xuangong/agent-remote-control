import type { Plugin } from 'vite';
import type { Plugin as EsbuildPlugin } from 'esbuild';

export function workspaceSource(): Plugin;
export function workspaceSourceEsbuild(): EsbuildPlugin;
