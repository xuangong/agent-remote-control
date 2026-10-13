import { act } from 'react';
import { render } from '../test/setup.js';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Team } from '@orchardworks/agent-remote-protocol';
const fixture=vi.hoisted(()=>({teams:[] as any[],attached:[] as string[],actions:[] as any[],failure:''}));
vi.mock('@orchardworks/agent-remote-web/headless',()=>({RemoteTeamClient:class{async list(){return structuredClone(fixture.teams);}async action(input:unknown){fixture.actions.push(input);if(fixture.failure)throw new Error(fixture.failure);return fixture.teams[0];}}}));
vi.mock('../directory-client.js',()=>({SessionDirectoryClient:class{async attach(_:string,id:string){fixture.attached.push(id);return {agentId:id};}}}));
vi.mock('../hooks/useConversationSession.js',()=>({useConversationSession:()=>({state:undefined,sessionState:undefined,status:'connected',actions:{},questions:{},setQuestions:()=>{}})}));
vi.mock('./LabWorkbench.js',()=>({LabWorkbench:(props:any)=><div data-testid="standard-session-view">{props.conversationPath}<textarea aria-label="Message" /></div>}));
import { TeamMenu } from './TeamMenu.js';
const team:Team={id:'team',operationId:'create',revision:1,title:'Cross-platform diagnosis',status:'active',source:{hostId:'mac',providerId:'fixture',nativeSessionId:'source',title:'Main project'},members:[
  {id:'leader',hostId:'mac',providerId:'fixture',nativeSessionId:'leader-session',role:'leader',name:'Leader',responsibility:'Coordinate',creation:'ready',activity:'idle',summary:'',updatedAt:1},
  {id:'worker',hostId:'win',providerId:'fixture',nativeSessionId:'worker-session',role:'member',name:'Windows',responsibility:'Verify',creation:'ready',activity:'idle',summary:'',updatedAt:1},
],messages:[],createdAt:1,updatedAt:1};
function App(){return <TeamMenu baseUrl="https://team.test" enabled hosts={[]} onOpen={async team=>{fixture.attached.push(team.id);return true;}} onOpenSession={async target=>{fixture.attached.push(target.nativeSessionId);return true;}}/>;}
afterEach(()=>{localStorage.clear();sessionStorage.clear();fixture.attached=[];fixture.teams=[];fixture.actions=[];fixture.failure='';});
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent)?.includes(text))!;
it('groups Teams and requests a layout without mounting another workspace',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App/>);
  await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain('Main project');await act(async()=>button(view,'Cross-platform diagnosis').click());
  expect(fixture.attached).toEqual(['team']);expect(view.querySelectorAll('[data-testid="standard-session-view"]')).toHaveLength(0);
});
it('keeps archived Team management in the grouped floating menu',async()=>{
  fixture.teams=[{...structuredClone(team),status:'archived'}];const view=await render(<App/>);await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain('Archived');expect(view.textContent).toContain('Main project');
  await act(async()=>button(view,'Restore').click());expect(fixture.actions).toEqual([{teamId:'team',action:'restore'}]);expect(fixture.attached).toEqual([]);
});
it('manages archive, recovery and member navigation without opening a Team layout',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App/>);await act(async()=>button(view,'Teams').click());
  await act(async()=>button(view,'Archive').click());expect(fixture.actions).toEqual([{teamId:'team',action:'archive'}]);
  await act(async()=>button(view,'Windows').click());expect(fixture.attached).toEqual(['worker-session']);
});
it('preserves a failed action notice across successful list refreshes',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App/>);
  await act(async()=>button(view,'Teams').click());
  fixture.failure='Archive was not accepted';await act(async()=>button(view,'Archive').click());
  expect(view.textContent).toContain(fixture.failure);
  await act(async()=>button(view,'Teams').click());await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain(fixture.failure);
});
