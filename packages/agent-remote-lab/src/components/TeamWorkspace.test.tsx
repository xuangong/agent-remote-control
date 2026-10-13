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
import { TeamWorkspace } from './TeamWorkspace.js';
const team:Team={id:'team',operationId:'create',revision:1,title:'Cross-platform diagnosis',status:'active',source:{hostId:'mac',providerId:'fixture',nativeSessionId:'source',title:'Main project'},members:[
  {id:'leader',hostId:'mac',providerId:'fixture',nativeSessionId:'leader-session',role:'leader',name:'Leader',responsibility:'Coordinate',creation:'ready',activity:'idle',summary:'',updatedAt:1},
  {id:'worker',hostId:'win',providerId:'fixture',nativeSessionId:'worker-session',role:'member',name:'Windows',responsibility:'Verify',creation:'ready',activity:'idle',summary:'',updatedAt:1},
],messages:[],createdAt:1,updatedAt:1};
function App({compact=false}:{compact?:boolean}){const [mount,setMount]=useState<HTMLDivElement|null>(null);return <><div ref={setMount}/><TeamWorkspace baseUrl="https://team.test" enabled compact={compact} hosts={[]} transport={{} as any} draftStore={{} as any} mount={mount} onModeChange={()=>{}} /></>;}
afterEach(()=>{localStorage.clear();sessionStorage.clear();fixture.attached=[];fixture.teams=[];fixture.actions=[];fixture.failure='';});
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent)?.includes(text))!;
it('groups Teams by source and opens Leader directly on narrow screens without attaching other panes',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App compact/>);
  await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain('Main project');await act(async()=>button(view,'Cross-platform diagnosis').click());
  expect(fixture.attached).toEqual(['leader-session']);expect(view.querySelectorAll('[data-testid="standard-session-view"]')).toHaveLength(1);
  const select=view.querySelector<HTMLSelectElement>('.lab-team-select select')!;expect(select.value).toBe('leader');
  await act(async()=>{select.value='worker';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(fixture.attached).toEqual(['leader-session','worker-session']);
  await act(async()=>button(view,'Exit Team mode').click());expect(view.querySelector('.lab-team-select')).toBeNull();
});
it('uses ordinary Session Views in source, Leader, member order on wide screens',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App/>);await act(async()=>button(view,'Teams').click());
  await act(async()=>button(view,'Cross-platform diagnosis').click());
  expect(view.querySelectorAll('[data-testid="standard-session-view"]')).toHaveLength(3);
  expect(fixture.attached).toEqual(['source','leader-session','worker-session']);
  expect([...view.querySelectorAll('[role="separator"]')].map(node=>node.getAttribute('aria-label'))).toEqual(['Resize Main · Main project','Resize Leader','Resize Windows']);
});
it('organizes archived Teams under the same source group',async()=>{
  fixture.teams=[{...structuredClone(team),status:'archived'}];const view=await render(<App compact/>);await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain('Archived');expect(view.textContent).toContain('Main project');
  await act(async()=>button(view,'Cross-platform diagnosis').click());expect(button(view,'Restore')).toBeTruthy();
});

it('preserves a failed action notice across successful list refreshes',async()=>{
  fixture.teams=[structuredClone(team)];const view=await render(<App compact/>);
  await act(async()=>button(view,'Teams').click());await act(async()=>button(view,'Cross-platform diagnosis').click());
  fixture.failure='Archive was not accepted';await act(async()=>button(view,'Archive').click());
  expect(view.textContent).toContain(fixture.failure);
  await act(async()=>button(view,'Teams').click());
  expect(view.textContent).toContain(fixture.failure);
});
