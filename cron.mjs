import { spawn } from 'child_process';

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

// --- Boom login helpers (copied from check.mjs) ---
class Jar {
  constructor() {
    this.map = new Map();
  }
  ingest(setCookie) {
    if (!setCookie) return;
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const ln of lines) {
      const m = String(ln).match(/^([^=]+)=([^;]+)/);
      if (m) this.map.set(m[1].trim(), m[2]);
    }
  }
  get(name) {
    return this.map.get(name) || "";
  }
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}
const jar = new Jar();

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join('&');
}

async function jf(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('accept', 'application/json, text/plain, */*');
  const ck = jar.header();
  if (ck) headers.set('cookie', ck);

  const csrfHeader = env('CSRF_HEADER_NAME');
  const csrfCookie = env('CSRF_COOKIE_NAME');
  if (csrfHeader && csrfCookie && !headers.has(csrfHeader)) {
    const val = jar.get(csrfCookie);
    if (val) headers.set(csrfHeader, decodeURIComponent(val));
  }

  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  const setc = res.headers.get('set-cookie');
  if (setc) jar.ingest(setc);

  // follow redirects
  let r = res, hops = 0;
  while ([301,302,303,307,308].includes(r.status) && hops < 3) {
    const loc = r.headers.get('location');
    if (!loc) break;
    r = await fetch(new URL(loc, url), { headers, redirect: 'manual' });
    const setc2 = r.headers.get('set-cookie');
    if (setc2) jar.ingest(setc2);
    hops++;
  }
  return r;
}

async function login() {
  const BOOM_USER  = env('BOOM_USER');
  const BOOM_PASS  = env('BOOM_PASS');
  const LOGIN_URL  = env('LOGIN_URL');
  const LOGIN_METHOD = env('LOGIN_METHOD', 'POST');
  const LOGIN_CT   = env('LOGIN_CT', 'application/json');
  const LOGIN_EMAIL_FIELD    = env('LOGIN_EMAIL_FIELD', 'email');
  const LOGIN_PASSWORD_FIELD = env('LOGIN_PASSWORD_FIELD', 'password');
  const LOGIN_TENANT_FIELD   = env('LOGIN_TENANT_FIELD', '');

  if (!LOGIN_URL || !BOOM_USER || !BOOM_PASS) {
    throw new Error('LOGIN_URL or BOOM_USER/BOOM_PASS missing');
  }

  const bodyObj = {
    [LOGIN_EMAIL_FIELD]: BOOM_USER,
    [LOGIN_PASSWORD_FIELD]: BOOM_PASS,
  };
  if (LOGIN_TENANT_FIELD) bodyObj[LOGIN_TENANT_FIELD] = null;

  const headers = {};
  let body;
  if (LOGIN_CT.includes('json')) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(bodyObj);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = formEncode(bodyObj);
  }

  const res = await jf(LOGIN_URL, { method: LOGIN_METHOD, headers, body });
  if (res.status >= 400) throw new Error(`Login failed: ${res.status}`);

  let token = null;
  try {
    const j = await res.clone().json();
    token = j?.token || j?.accessToken || j?.data?.accessToken || null;
  } catch {}
  return token;
}

// --- Conversation listing and checking ---
async function listConversations(fetchFn) {
  function env(name, d = '') { return process.env[name] ?? d; }
  function inferConversationsUrl() {
    const m = env('MESSAGES_URL', '');
    if (!m) return '';
    // turn .../conversations/{{conversationId}}/messages[...] into .../conversations?limit=50&sort=updatedAt&order=desc
    return m.replace(/\/conversations\/\{\{?conversationId\}?\}\/messages.*$/i,
                     '/conversations?limit=50&sort=updatedAt&order=desc');
  }

  const url = env('CONVERSATIONS_URL') || inferConversationsUrl();
  if (!url) throw new Error('CONVERSATIONS_URL not set and could not infer from MESSAGES_URL');

  const method = env('CONVERSATIONS_METHOD', 'GET');
  const res = await fetchFn(url, { method, headers: { accept: 'application/json' } });
  const ctype = String(res.headers?.get?.('content-type') || '').toLowerCase();
  const text = await res.text();
  if (!ctype.includes('application/json')) {
    throw new Error(`CONVERSATIONS_URL returned non-JSON (${ctype || 'unknown'}). First bytes: ` + text.slice(0,160));
  }

  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Failed to parse JSON from CONVERSATIONS_URL: ' + e.message);
  }

  // Accept a few shapes:
  let list = Array.isArray(data) ? data
           : Array.isArray(data.conversations) ? data.conversations
           : Array.isArray(data.items) ? data.items
           : [];

  const ids = [...new Set(list.map(x => x?.conversationId || x?.id || x?.uuid).filter(Boolean))];
  if (!ids.length) throw new Error('No conversation ids found in CONVERSATIONS response.');
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
    await login();
    const ids = await listConversations(jf);
    for (const id of ids) {
      await runCheck(id);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();

