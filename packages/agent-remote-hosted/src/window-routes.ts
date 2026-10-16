import { isWindowDeleteRequest, isWindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { WindowServiceError, type WindowPrincipal, type createWindowWorkspaces } from './window-workspaces.js';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export async function handleWindowRequest(service: ReturnType<typeof createWindowWorkspaces>, request: Request, principal: WindowPrincipal, changesWaitMs?: number): Promise<Response> {
  try {
    const url = new URL(request.url); const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[2] && decodeURIComponent(parts[2]); const method = request.method;
    const body = async () => {
      const tooLarge = () => new WindowServiceError(413, 'body_too_large', 'Window request is too large.');
      if (Number(request.headers.get('content-length')) > 300000) throw tooLarge();
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      if (reader) { try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 300000) { await reader.cancel(); throw tooLarge(); } chunks.push(part.value); } } finally { reader.releaseLock(); } }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new WindowServiceError(400, 'invalid_json', 'JSON is required.'); }
    };
    if (!id && parts.length === 2) {
      if (method === 'GET') return json(200, service.list(principal));
      if (method === 'POST') { const input = await body(); return json(200, await service.create(principal, input)); }
    }
    if (id && parts.length === 3) {
      if (method === 'GET') return json(200, service.inspect(principal, id));
      if (method === 'DELETE') { const input = await body(); if (!isWindowDeleteRequest(input)) return json(400, { code: 'invalid_operation' }); return json(200, await service.mutate(principal, id, input)); }
    }
    if (id && parts[3] === 'operations') {
      if (method === 'GET' && parts.length === 5) return json(200, service.operation(principal, id, decodeURIComponent(parts[4]!)));
      if (method === 'POST' && parts.length === 4) { const input = await body(); return json(200, await service.mutate(principal, id, input)); }
    }
    if (id && parts[3] === 'manager' && parts.length === 4 && method === 'POST') {
      const input = await body(); if (!input || Object.keys(input).join(',') !== 'session' || input.session !== null && !isWindowSessionBinding(input.session)) return json(400, { code: 'invalid_manager' });
      return json(200, await service.assign(principal, id, input.session));
    }
    if (id && parts[3] === 'changes' && parts.length === 4 && method === 'GET') {
      const raw = url.searchParams.get('afterRevision'); const revision = raw === null ? NaN : Number(raw);
      if (!Number.isSafeInteger(revision) || revision < 0) return json(400, { code: 'invalid_revision' });
      return json(200, await service.changes(principal, id, revision, request.signal, changesWaitMs));
    }
    return json(405, { code: 'method_not_allowed' });
  } catch (error) { if (error instanceof WindowServiceError) return json(error.status, { code: error.code, error: error.message }); throw error; }
}
