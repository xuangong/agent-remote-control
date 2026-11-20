import { accessLanguageKey, accessLocale, accessView, accessWord, signInReturnKey, type AccessLocale } from './access-page.js';
import { accessDocument, accessPanel, escapeHtml } from './auth-page.js';

/** The callback page's states in both languages: the script switches among them without a second request. */
function callbackViews() {
  const of = (locale: AccessLocale) => ({
    title: accessWord(locale, 'page.signIn'),
    verifying: accessView('verifying', locale, { surface: 'relay' }),
    opening: accessView('opening', locale, { surface: 'relay' }),
    openingSession: accessView('opening', locale, { surface: 'relay', sessionLink: true }),
    expired: accessView('expired', locale, { surface: 'relay' }),
    unavailable: accessView('unavailable', locale, { surface: 'relay' }),
  });
  return { en: of('en'), zh: of('zh') };
}

export function authenticationCallback(origin: string, languages?: string | null): Response {
  const locale = accessLocale(languages);
  const script = `
const views=${JSON.stringify(callbackViews())};
const returnKey=${JSON.stringify(signInReturnKey)};
let language=${JSON.stringify(locale)};
try { const stored=localStorage.getItem(${JSON.stringify(accessLanguageKey)}); if(stored==='zh'||stored==='en')language=stored; } catch {}
const words=views[language];
document.documentElement.lang=language==='zh'?'zh-CN':'en';
document.title=words.title;
const page=document.querySelector('.arc-access');
const status=document.getElementById('access-status');
const title=document.getElementById('access-title');
const description=document.getElementById('access-description');
const retry=document.getElementById('access-retry');
const back=document.getElementById('access-back');
let target='/';
try { const saved=sessionStorage.getItem(returnKey); if(saved&&(saved==='/'||saved.startsWith('/?'))&&saved.length<=32768)target=saved; } catch {}
retry.href='/auth/login'+target.slice(1);
function show(state) {
  const view=words[state];
  page.dataset.state=state==='openingSession'?'opening':state;
  if(view.kind==='wait'){status.textContent=view.sentence;return;}
  page.dataset.kind='card';
  title.textContent=view.title;
  description.textContent=view.description;
  description.setAttribute('role','alert');
  retry.textContent=view.action;
  back.textContent=view.secondary;
  title.focus();
}
status.textContent=words.verifying.sentence;
const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');
history.replaceState(null,'','/auth/callback');
if(!ticket)show('expired');
else {
  const abort=new AbortController();
  const deadline=setTimeout(()=>abort.abort(),12000);
  fetch('/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket}),signal:abort.signal})
    .then(async response=>{
      if(!response.ok){show(response.status===401||response.status===403?'expired':'unavailable');return;}
      const state=await response.json();
      const path=state.returnPath||(state.hostId?'/?host='+encodeURIComponent(state.hostId):'/');
      if(typeof path!=='string'||!(path==='/'||path.startsWith('/?')))throw Error();
      show(/[?&](session|agent)=/.test(path)?'openingSession':'opening');
      try{sessionStorage.removeItem(returnKey);}catch{}
      location.replace(path);
    }).catch(()=>show('unavailable')).finally(()=>clearTimeout(deadline));
}
`;
  const view = accessView('verifying', locale, { surface: 'relay' });
  const actions = `<a class="arc-access-action" id="access-retry" href="/auth/login">${escapeHtml(accessWord(locale, 'action.signInAgain'))}</a><a class="arc-access-secondary" id="access-back" href="/">${escapeHtml(accessWord(locale, 'action.back'))}</a>`;
  const page = accessDocument({ locale, title: 'page.signIn', script, body: accessPanel({ state: 'verifying', view, host: new URL(origin).host, actions, switching: true, noscript: accessWord(locale, 'noscript') }) });
  return new Response(page.html, { status: 200, headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'sha256-${page.styleHash}'; script-src 'sha256-${page.scriptHash}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  } });
}
