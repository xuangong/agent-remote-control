import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {expect, it} from 'vitest';
import {ClaudeAgentProvider} from '../dist/provider.js';

it('persists one native custom title in the configured Claude home without spawning a session', async () => {
  const home=await mkdtemp(join(tmpdir(),'arc-claude-rename-'));
  const sessionId=randomUUID();const cwd=join(home,'workspace');
  const project=join(home,'profile','projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));
  const file=join(project,sessionId+'.jsonl');
  try {
    await mkdir(project,{recursive:true});await mkdir(cwd);
    await writeFile(file,JSON.stringify({type:'user',uuid:randomUUID(),parentUuid:null,sessionId,cwd,timestamp:new Date().toISOString(),
      message:{role:'user',content:'Rename fixture'}})+'\n');
    const provider=new ClaudeAgentProvider({env:{CLAUDE_CONFIG_DIR:join(home,'profile')},query:()=>{throw new Error('Must not start a query');}});
    expect(await provider.readSessionTitle(sessionId)).toBe('Rename fixture');
    expect(await provider.renameSession(sessionId,'原生 Claude title')).toBe('原生 Claude title');
    expect(await provider.renameSession(sessionId,'原生 Claude title')).toBe('原生 Claude title');
    expect((await provider.listSessions()).find(item=>item.nativeSessionId===sessionId)?.title).toBe('原生 Claude title');
    const entries=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(entries.filter(entry=>entry.type==='custom-title')).toHaveLength(1);
    expect(entries.find(entry=>entry.type==='user').message.content).toBe('Rename fixture');
    await provider.dispose();
    const fresh=new ClaudeAgentProvider({env:{CLAUDE_CONFIG_DIR:join(home,'profile')}});
    try {expect(await fresh.readSessionTitle(sessionId)).toBe('原生 Claude title');} finally {await fresh.dispose();}
  } finally {await rm(home,{recursive:true,force:true});}
}, 20000);
