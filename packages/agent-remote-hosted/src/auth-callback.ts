import { createHash } from 'node:crypto';
import { accessBrandMark, accessCopy, accessPageStyle, signInReturnKey } from './access-page.js';

export function authenticationCallback(origin: string): Response {
  const css = 'body{margin:0}' + accessPageStyle;
  const script = `
const copy=${JSON.stringify(accessCopy)};
const returnKey=${JSON.stringify(signInReturnKey)};
const page=document.querySelector('.arc-access');
const actions=document.getElementById('access-actions');
const activity=document.getElementById('access-activity');
const retry=document.getElementById('access-retry');
let target='/';
try { const saved=sessionStorage.getItem(returnKey); if(saved&&(saved==='/'||saved.startsWith('/?'))&&saved.length<=32768)target=saved; } catch {}
retry.href='/auth/login'+target.slice(1);
function show(state) {
  page.dataset.state=state;
  document.getElementById('access-title').textContent=copy[state].title;
  const description=document.getElementById('access-description');
  description.textContent=copy[state].description;
  if(!copy[state].status)description.setAttribute('role','alert');
  document.getElementById('access-eyebrow').textContent=copy[state].status?'Continue on this device':'Sign-in interrupted';
  activity.textContent=copy[state].status;
  activity.hidden=!copy[state].status;
  actions.hidden=!!copy[state].status;
  for(const [index,step] of [...document.querySelectorAll('.arc-access-progress li')].entries()) {
    if(index===(state==='opening'?2:1))step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');
  }
  if(!copy[state].status)document.getElementById('access-title').focus();
}
const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');
history.replaceState(null,'','/auth/callback');
if(!ticket)show('expired');
else {
  show('verifying');
  const abort=new AbortController();
  const deadline=setTimeout(()=>abort.abort(),12000);
  fetch('/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket}),signal:abort.signal})
    .then(async response=>{
      if(!response.ok){show(response.status===401||response.status===403?'expired':'unavailable');return;}
      const state=await response.json();
      const path=state.returnPath||(state.hostId?'/?host='+encodeURIComponent(state.hostId):'/');
      if(typeof path!=='string'||!(path==='/'||path.startsWith('/?')))throw Error();
      show('opening');
      try{sessionStorage.removeItem(returnKey);}catch{}
      location.replace(path);
    }).catch(()=>show('unavailable')).finally(()=>clearTimeout(deadline));
}
`;
  const digest = (value: string) => createHash('sha256').update(value).digest('base64');
  const host = new URL(origin).host.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Sign in · Agent Remote</title><style>${css}</style></head><body>
<main class="arc-access" data-state="verifying">
  <header class="arc-access-brand">${accessBrandMark}Agent Remote</header>
  <section class="arc-access-body" aria-labelledby="access-title">
    <ol class="arc-access-progress" aria-label="Sign-in progress"><li><span>1</span>Open link</li><li aria-current="step"><span>2</span>Sign in</li><li><span>3</span>Open session</li></ol>
    <p class="arc-access-eyebrow" id="access-eyebrow">Continue on this device</p>
    <h1 id="access-title" tabindex="-1">${accessCopy.verifying.title}</h1>
    <p class="arc-access-description" id="access-description">${accessCopy.verifying.description}</p>
    <p class="arc-access-activity" id="access-activity" role="status">${accessCopy.verifying.status}</p>
    <div class="arc-access-actions" id="access-actions"><a class="arc-access-action" id="access-retry" href="/auth/login">Sign in again</a><a class="arc-access-secondary" href="/">Back to Agent Remote</a></div>
    <p class="arc-access-note">Sign-in happens in this browser. Your session opens when access is confirmed.</p>
    <noscript><p>JavaScript is required to finish signing in. Enable it, then start sign-in again.</p></noscript>
  </section>
  <footer class="arc-access-footer"><span>Agent Remote Control</span><span class="arc-access-host">${host}</span></footer>
</main><script>${script}</script></body></html>`, { status: 200, headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'sha256-${digest(css)}'; script-src 'sha256-${digest(script)}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  } });
}
