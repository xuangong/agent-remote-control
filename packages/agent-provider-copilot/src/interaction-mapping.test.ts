import {expect, it} from 'vitest';
import type {SessionEvent} from '@github/copilot-sdk';
import {interactionRequest} from './interaction-mapping.js';
function permission(permissionRequest: object, promptRequest?: object) {
 return interactionRequest({type: 'permission.requested', data: {requestId: 'permission', permissionRequest, promptRequest}} as SessionEvent);
}
it('uses human intent and one structured command, preserving native warnings', () => {
 expect(permission({kind: 'shell', fullCommandText: 'pwd', intention: 'Show current directory'}, {kind: 'commands', commandIdentifiers: ['pwd'], fullCommandText: 'pwd', canOfferSessionApproval: false, warning: 'Check the directory'})).toMatchObject({summary: 'Show current directory', detail: {type: 'shell', command: 'pwd'}, allowScopes: ['once'], context: expect.arrayContaining([{label: 'Warning', value: 'Check the directory'}])});
});
it('distinguishes path access from the subsequent read-tool approval', () => {
 const raw = {kind: 'read', path: '/outside', intention: 'Read source'};
 const path = permission(raw, {kind: 'path', accessKind: 'read', paths: ['/outside']});
 const read = permission(raw, {kind: 'read', path: '/outside', intention: 'Read source'});
 expect(path).toMatchObject({toolName: 'Path access', summary: 'Allow read access to this path.'});
 expect(read).toMatchObject({toolName: 'read', summary: 'Read source', allowScopes: ['once', 'session']});
 expect(read?.summary).not.toContain('toolCallId');
});
it('offers session command approval only when the native prompt allows it', () => {
 expect(permission({kind: 'shell', fullCommandText: 'pwd'}, {kind: 'commands', commandIdentifiers: ['pwd'], canOfferSessionApproval: true})).toMatchObject({allowScopes: ['once', 'session']});
 expect(permission({kind: 'shell', fullCommandText: 'pwd'}, {kind: 'commands', commandIdentifiers: ['pwd'], canOfferSessionApproval: true, managedApprovalRequired: true})).toMatchObject({allowScopes: ['once']});
});
it('keeps URL targets and sandbox-bypass warnings when removing the raw summary', () => {
 expect(permission({kind: 'url', url: 'https://example.com', intention: 'Read documentation'}, {kind: 'url', url: 'https://example.com', requestSandboxBypass: true, requestSandboxBypassReason: 'Network restriction'})).toMatchObject({summary: 'Read documentation', context: expect.arrayContaining([{label: 'URL', value: 'https://example.com'}, {label: 'Network access', value: 'Requests bypass of the sandbox network policy.'}])});
});
it('keeps all requested paths and names the scope of a session grant', () => {
 expect(permission({kind: 'read', path: '/first'}, {kind: 'path', accessKind: 'read', paths: ['/first', '/second']})).toMatchObject({context: expect.arrayContaining([{label: 'Paths', value: '/first\n/second'}])});
});
