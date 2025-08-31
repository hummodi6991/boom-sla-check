import { spawn } from 'child_process';

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

// --- Auto-login fetch wrapper ---
async function login(fetchFn) {
  const url = process.env.LOGIN_URL || '';
  const method = (process.env.LOGIN_METHOD || 'POST').toUpperCase();
  const user = process.env.BOOM_USER || '';
  const pass = process.env.BOOM_PASS || '';
  if (!url || !user || !pass) throw new Error('Missing LOGIN_URL/BOOM_USER/BOOM_PASS');

  const body = JSON.stringify({ email: user, password: pass });
  const res = await fetchFn(url, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body
  });
  // capture cookies
  const setCookie = res.headers?.getSetCookie?.() || res.headers?.raw?.()['set-cookie'] || [];
  const cookies = Array.isArray(setCookie) ? setCookie.map(s => s.split(';',1)[0]).join('; ') : '';
  if (res.status >= 400) throw new Error('Login failed: ' + res.status + ' ' + res.statusText);
  return { cookies };
}

function buildAuthFetch() {
  let cookies = '';
  const baseFetch = globalThis.fetch;

  return async (url, init={}) => {
    const headers = Object.fromEntries(Object.entries(init.headers||{}));
    if (cookies) headers['cookie'] = cookies;
    headers['accept'] = headers['accept'] || 'application/json';

    let res = await baseFetch(url, { ...init, headers });
    const ctype = String(res.headers?.get?.('content-type')||'').toLowerCase();

    // If we got HTML (likely a login page), try to login once and retry
    if (ctype.includes('text/html')) {
      const auth = await login((u,i)=>baseFetch(u,{...i, headers:{...(i?.headers||{}), accept:'application/json'}}));
      if (auth.cookies) cookies = auth.cookies;
      const hdrs2 = { ...headers, cookie: cookies };
      res = await baseFetch(url, { ...init, headers: hdrs2 });
    }
    return res;
  };
}

// --- Conversation listing and checking ---
async function listConversations() {
  function inferConversationsUrl() {
    const m = env('MESSAGES_URL','');
    if (!m) return '';
    return m.replace(/\/conversations\/\{\{?conversationId\}?\}\/messages.*$/i,
                     '/conversations?limit=50&sort=updatedAt&order=desc');
  }
  const url = env('CONVERSATIONS_URL') || inferConversationsUrl();
  if (!url) throw new Error('CONVERSATIONS_URL not set and could not infer from MESSAGES_URL');

  const method = env('CONVERSATIONS_METHOD','GET');
  const authFetch = buildAuthFetch();
  const res = await authFetch(url, { method, headers: { accept:'application/json' } });
  const ctype = String(res.headers?.get?.('content-type')||'').toLowerCase();
  const text = await res.text();

  if (!ctype.includes('application/json')) {
    throw new Error(`CONVERSATIONS_URL returned non-JSON (${ctype||'unknown'}). First bytes: ${text.slice(0,160)}`);
  }
  let data; try { data = JSON.parse(text); } catch(e){ throw new Error('Bad JSON from conversations: '+e.message); }

  const list = Array.isArray(data) ? data
             : Array.isArray(data.conversations) ? data.conversations
             : Array.isArray(data.items) ? data.items
             : [];
  const ids = [...new Set(list.map(x => x?.conversationId || x?.id || x?.uuid).filter(Boolean))];
  if (!ids.length) throw new Error('No conversation ids found in conversations response.');
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
