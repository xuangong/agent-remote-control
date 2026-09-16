import type { AgentInteractionRequest } from '@agent-remote-controller/agent-provider-sdk';
import { isRecord, readString } from './native.js';

type Permission = Extract<AgentInteractionRequest, { kind: 'permission_approval' }>['permissions'][number];

export function mapCodexPermissions(value: unknown): { permissions: Permission[]; grant: Record<string, unknown> } {
  if (!isRecord(value)) throw new Error('Missing permissions');
  exactKeys(value, ['network', 'fileSystem']);
  const permissions: Permission[] = [];
  const grant: Record<string, unknown> = {};
  if (value.network != null) {
    if (!isRecord(value.network)) throw new Error('Invalid network permissions');
    exactKeys(value.network, ['enabled']);
    if (value.network.enabled !== null && typeof value.network.enabled !== 'boolean') throw new Error('Invalid network grant');
    if (value.network.enabled !== null) permissions.push({ resource: 'network', access: value.network.enabled ? 'connect' : 'deny', target: '*' });
    grant.network = structuredClone(value.network);
  }
  if (value.fileSystem != null) {
    const fs = value.fileSystem;
    if (!isRecord(fs)) throw new Error('Invalid filesystem permissions');
    exactKeys(fs, ['read', 'write', 'entries', 'globScanMaxDepth']);
    if (fs.globScanMaxDepth !== undefined && (!Number.isSafeInteger(fs.globScanMaxDepth) || (fs.globScanMaxDepth as number) < 0)) throw new Error('Invalid glob scan depth');
    for (const access of ['read', 'write'] as const) {
      if (fs[access] == null) continue;
      if (!Array.isArray(fs[access])) throw new Error('Invalid filesystem paths');
      for (const target of fs[access] as unknown[]) {
        if (typeof target !== 'string' || !target) throw new Error('Invalid filesystem path');
        permissions.push({ resource: 'filesystem', access, target });
      }
    }
    if (fs.entries !== undefined) {
      if (!Array.isArray(fs.entries)) throw new Error('Invalid filesystem entries');
      for (const entry of fs.entries) {
        if (!isRecord(entry) || !['read', 'write', 'deny'].includes(String(entry.access))) throw new Error('Unsupported filesystem access');
        exactKeys(entry, ['path', 'access']);
        permissions.push({ resource: 'filesystem', access: entry.access as 'read' | 'write' | 'deny', target: pathLabel(entry.path, fs.globScanMaxDepth) });
      }
    }
    grant.fileSystem = structuredClone(fs);
  }
  if (!permissions.length || permissions.length > 256) throw new Error('Empty or excessive permissions');
  return { permissions, grant };
}

function pathLabel(value: unknown, depth: unknown): string {
  if (!isRecord(value)) throw new Error('Invalid filesystem target');
  if (value.type === 'path') {
    exactKeys(value, ['type', 'path']);
    if (!readString(value.path)) throw new Error('Invalid filesystem path');
    return value.path as string;
  }
  if (value.type === 'glob_pattern') {
    exactKeys(value, ['type', 'pattern']);
    if (!readString(value.pattern)) throw new Error('Invalid glob pattern');
    return `glob: ${value.pattern}${depth !== undefined ? ` (scan depth: ${depth})` : ''}`;
  }
  if (value.type === 'special' && isRecord(value.value)) {
    exactKeys(value, ['type', 'value']);
    const special = value.value;
    if (!['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp', 'unknown'].includes(String(special.kind))) throw new Error('Unsupported special path');
    exactKeys(special, special.kind === 'project_roots' ? ['kind', 'subpath'] : special.kind === 'unknown' ? ['kind', 'path', 'subpath'] : ['kind']);
    if (special.subpath != null && !readString(special.subpath)) throw new Error('Invalid special subpath');
    if (special.kind === 'unknown' && !readString(special.path)) throw new Error('Invalid special path');
    return `special: ${special.kind}${special.kind === 'unknown' ? ` (${special.path})` : ''}${special.subpath != null ? ` / ${special.subpath}` : ''}`;
  }
  throw new Error('Unsupported filesystem target');
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unsupported permission property');
}
