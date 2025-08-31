import { spawn } from 'child_process';

async function loginAndGetCookies(baseFetch){
  const url=(process.env.LOGIN_URL||'').trim();
  const method=(process.env.LOGIN_METHOD||'POST').toUpperCase();
  const user=(process.env.BOOM_USER||'').trim();
  const pass=(process.env.BOOM_PASS||'').trim();
  if(!url||!user||!pass) throw new Error('Missing LOGIN_URL/BOOM_USER/BOOM_PASS');

  const body = JSON.stringify({ email:user, password:pass });
  const res = await baseFetch(url,{ method, headers:{accept:'application/json','content-type':'application/json'}, body });

  // Best-effort cookie extraction (undici Headers)
  const sc = res.headers?.get?.('set-cookie') || '';
  if (res.status>=400) throw new Error('Login failed: '+res.status+' '+res.statusText);
  return sc.split(',').map(v=>v.split(';',1)[0]).filter(Boolean).join('; ');
}

function buildAuthFetch(){
  const baseFetch = globalThis.fetch;
  let cookies = '';

  return async (url, init={})=>{
    const headers = { accept:'application/json', ...(init.headers||{}) };
    if (cookies) headers.cookie = cookies;

    let res = await baseFetch(url,{...init, headers});
    let ctype = String(res.headers?.get?.('content-type')||'').toLowerCase();

    // If not JSON or empty content-type, login once and retry
    if (!ctype.includes('application/json')) {
      try {
        if (!cookies) cookies = await loginAndGetCookies(baseFetch);
        res = await baseFetch(url,{...init, headers:{...headers, cookie:cookies}});
        ctype = String(res.headers?.get?.('content-type')||'').toLowerCase();
      } catch(e){
        throw new Error('Auth retry failed: '+e.message);
      }
    }
    return res;
  };
}

// --- Conversation listing and checking ---
async function listConversations() {
  const env = (k,d='')=> (process.env[k] ?? d).toString();
  const inferFromMessages = ()=>{
    const m = env('MESSAGES_URL','');
    if(!m) return '';
    return m.replace(/\/conversations\/\{\{?conversationId\}?\}\/messages.*$/i,
                     '/conversations?limit=50&sort=updatedAt&order=desc');
  };

  const url = env('CONVERSATIONS_URL') || inferFromMessages();
  if(!url) throw new Error('CONVERSATIONS_URL not set and could not infer from MESSAGES_URL');
  const method = env('CONVERSATIONS_METHOD','GET').toUpperCase();

  const authFetch = buildAuthFetch();
  const res = await authFetch(url,{ method, headers:{accept:'application/json'} });
  const status = res.status;
  const ctype = String(res.headers?.get?.('content-type')||'').toLowerCase();
  const text  = await res.text();

  if (!ctype.includes('application/json')) {
    throw new Error(`CONVERSATIONS_URL returned non-JSON (${ctype || 'unknown'}), status ${status}. First bytes: ${text.slice(0,160)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch(e){ throw new Error('Bad JSON from conversations: '+e.message+' — first bytes: '+text.slice(0,160)); }

  const list = Array.isArray(data) ? data :
               Array.isArray(data.conversations) ? data.conversations :
               Array.isArray(data.items) ? data.items :
               Array.isArray(data.results) ? data.results : [];

  const ids = [...new Set(list.map(x => x?.conversationId || x?.id || x?.uuid).filter(Boolean))];
  if (!ids.length) {
    console.warn('No conversation ids found in conversations response; nothing to check.');
    return [];
  }
  return ids;
}

async function runCheck(id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./check.mjs', import.meta.url).pathname], {
      stdio: 'inherit',
      env: { ...process.env, CONVERSATION_INPUT: id }
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`check failed for ${id} (exit ${code})`));
    });
  });
}

(async () => {
  try {
    const ids = await listConversations();
    for (const id of ids) {
      await runCheck(id);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
