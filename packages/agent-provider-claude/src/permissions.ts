import type {PermissionUpdate} from '@anthropic-ai/claude-agent-sdk';

/** Preserve the entire native grant, but never persist it into user or project settings. */
export function claudeSessionGrant(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] | undefined {
 if (!suggestions?.length) return;
 if (!suggestions.every(update => update.type === 'addRules'
  ? update.behavior === 'allow' && update.rules.length > 0
    && update.rules.every(rule=>typeof rule.toolName === 'string' && !!rule.toolName && (rule.ruleContent === undefined || typeof rule.ruleContent === 'string'))
  : update.type === 'addDirectories' && update.directories.length > 0 && update.directories.every(path=>typeof path === 'string' && !!path))) return;
 return structuredClone(suggestions).map(update=>({...update,destination:'session'}));
}

export function claudeGrantDescription(grant: PermissionUpdate[]): string {
 return 'For this session: '+grant.flatMap(update=>update.type === 'addRules'
  ? update.rules.map(rule=>rule.toolName+(rule.ruleContent ? `(${rule.ruleContent})` : ''))
  : update.type === 'addDirectories' ? update.directories.map(path=>`directory access to ${path}`) : []).join('; ')+'.';
}
