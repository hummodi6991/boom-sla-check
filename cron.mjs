import { spawn } from 'child_process';

// small helper to read envs consistently
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const DEBUG = env('DEBUG','').length > 0;
const parseJSON = (s, fb={}) => { try { return JSON.parse(s); } catch { return fb; } };

async function loginAndGetCookies(baseFetch){
  const url=env('LOGIN_URL');
  const method=env('LOGIN_METHOD','POST').toUpperCase();
  const user=env('BOOM_USER');
  const pass=env('BOOM_PASS');
  if(!url||!user||!pass) throw new Error('Missing LOGIN_URL/BOOM_USER/BOOM_PASS');

  const body = JSON.stringify({ email:user, password:pass });
  const res = await baseFetch(url,{ method, headers:{accept:'application/json','content-type':'application/json'}, body });

  // Best-effort cookie extraction (undici Headers)
  const sc = res.headers?.get?.('set-cookie') || '';
  if (res.status>=400) throw new Error('Login failed: '+res.status+' '+res.statusText);
  return sc.split(',').map(v=>v.split(';',1)[0]).filter(Boolean).join('; ');
}

// New: token login (mirrors check.mjs)
async function loginForToken(baseFetch){
  const url=env('LOGIN_URL');
  const method=env('LOGIN_METHOD','POST').toUpperCase();
  const user=env('BOOM_USER');
  const pass=env('BOOM_PASS');
  if(!url||!user||!pass) throw new Error('Missing LOGIN_URL/BOOM_USER/BOOM_PASS');
  const res = await baseFetch(url,{
    method,
    headers:{accept:'application/json','content-type':'application/json'},
    body: JSON.stringify({ email:user, password:pass })
  });
  if (res.status>=400) throw new Error('Login failed: '+res.status);
  let token = null;
  try {
    const j = await res.clone().json();
    token = j?.token || j?.accessToken || j?.data?.accessToken || null;
  } catch {}
  return token;
}

function buildAuthFetch(){
  const baseFetch = globalThis.fetch;
  let cookies = '';
  let bearer  = '';
  const staticHeaderName  = env('CONVERSATIONS_AUTH_HEADER_NAME');   // e.g. "Authorization" or "Api-Key"
  const staticHeaderValue = env('CONVERSATIONS_AUTH_VALUE');         // e.g. "Token abc" or just the key
  const extraHeaders = parseJSON(env('CONVERSATIONS_EXTRA_HEADERS','{}')); // e.g. {"X-Org":"acme"}
  const csrfCookieName = env('CSRF_COOKIE_NAME');                    // e.g. "csrfToken"
  const csrfHeaderName = env('CSRF_HEADER_NAME');                    // e.g. "X-CSRF-Token"

  return async (url, init={})=>{
    const headers = { accept:'application/json', ...(init.headers||{}) };

    // 1) Prefer Bearer token (same as check.mjs)
    if (!bearer) {
      try { bearer = await loginForToken(baseFetch); } catch {}
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    // 2) Also carry cookies if we have them
    if (cookies) headers.cookie = cookies;
    if (staticHeaderName && staticHeaderValue) headers[staticHeaderName] = staticHeaderValue;
    Object.assign(headers, extraHeaders);

    if (csrfCookieName && csrfHeaderName && cookies) {
      const part = cookies.split('; ').find(c => c.startsWith(csrfCookieName + '='));
      if (part) headers[csrfHeaderName] = decodeURIComponent(part.split('=')[1] || '');
    }

    let res = await baseFetch(url,{...init, headers});
    let ctype = String(res.headers?.get?.('content-type')||'').toLowerCase();

    // 3) If the API still 401s or doesn’t return JSON, try cookie session login
    if (res.status === 401 || !ctype.includes('application/json')) {
      try {
        if (!cookies) cookies = await loginAndGetCookies(baseFetch);
        const hdr = {...headers, cookie:cookies};
        // If bearer didn’t work, drop it on retry to avoid confusing some gateways
        if (res.status === 401) delete hdr.Authorization;
        res = await baseFetch(url,{...init, headers:hdr});
        if (DEBUG) {
          console.log('[auth] retried with cookie session',
            { hadBearer: !!bearer, staticHeader: !!staticHeaderName, status: res.status });
        }
      } catch(e){
        throw new Error('Auth retry failed: '+e.message);
      }
    }
    return res;
  };
}

// --- Conversation listing and checking ---
async function listConversations() {
  const inferFromMessages = ()=>{
    const m = env('MESSAGES_URL','');
    if(!m) return '';
    // heuristic: turn .../conversations/{{conversationId}}/messages into a list view
    return m.replace(/\/conversations\/\{\{?conversationId\}?\}\/messages.*$/i,
                     '/conversations?limit=50&sort=updatedAt&order=desc');
  };

  // 0) Hard override: comma-separated IDs to avoid listing restrictions
  const idsCsv = env('CONVERSATION_IDS','');
  if (idsCsv) {
    const ids = idsCsv.split(',').map(s=>s.trim()).filter(Boolean);
    if (ids.length) {
      if (DEBUG) console.log('[list] using CONVERSATION_IDS override', ids);
      return ids;
    }
  }

  const url = env('CONVERSATIONS_URL') || inferFromMessages();
  if(!url) throw new Error('CONVERSATIONS_URL not set and could not infer from MESSAGES_URL');
  const method = env('CONVERSATIONS_METHOD','GET').toUpperCase();
  const bodyRaw = env('CONVERSATIONS_BODY','').trim();
  const hasBody = !!bodyRaw && method !== 'GET';

  const authFetch = buildAuthFetch?.() || fetch;
  const res = await authFetch(url,{
    method,
    headers:{
      'accept':'application/json',
      'content-type': hasBody ? 'application/json' : undefined,
      'x-requested-with':'XMLHttpRequest'
    },
    body: hasBody ? bodyRaw : undefined
  });
  if (DEBUG) console.log('[list] status', res.status);
  const status = res.status;
  const ctype = String(res.headers?.get?.('content-type')||'').toLowerCase();
  const text  = await res.text();

  if (!ctype.includes('application/json')) {
    throw new Error(`CONVERSATIONS_URL returned non-JSON (${ctype||'unknown'}), status ${status}. First bytes: ${text.slice(0,160)}`);
  }
  if (status >= 400) {
    throw new Error(`CONVERSATIONS_URL error ${status}. Body: ${text.slice(0,300)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch(e){ throw new Error('Bad JSON from conversations: '+e.message+' — first bytes: '+text.slice(0,160)); }

  // Flexible extraction
  const guessArray = (obj) => {
    if (Array.isArray(obj)) return obj;
    if (Array.isArray(obj?.conversations)) return obj.conversations;
    if (Array.isArray(obj?.items)) return obj.items;
    if (Array.isArray(obj?.results)) return obj.results;
    if (Array.isArray(obj?.data)) return obj.data;
    if (obj?.conversations?.data && Array.isArray(obj.conversations.data)) return obj.conversations.data;
    if (obj?.data?.conversations && Array.isArray(obj.data.conversations)) return obj.data.conversations;
    if (obj?.data?.items && Array.isArray(obj.data.items)) return obj.data.items;
    return null;
  };

  const arr = guessArray(data);

  const deepIds = new Set();
  const wanted = new Set(['conversationid','id','uuid']);
  const idFieldEnv = env('CONVERSATION_ID_FIELD','');
  if (idFieldEnv) wanted.add(idFieldEnv.toLowerCase());

  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    for (const [k,v] of Object.entries(x)) {
      if (wanted.has(String(k).toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) {
        const val = String(v).trim();
        if (val) deepIds.add(val);
      }
      if (v && typeof v === 'object') walk(v);
    }
  };

  if (arr) walk(arr); else walk(data);

  const ids = Array.from(deepIds);
  if (!ids.length) {
    const topKeys = Object.keys(data || {});
    const preview = text.slice(0, 400).replace(/\s+/g, ' ');
    console.log('No conversation ids found. Top-level keys:', topKeys);
    console.log('Preview:', preview);
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
