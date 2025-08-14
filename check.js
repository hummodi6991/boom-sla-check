// check.js
// node check.js --conversation "<URL>"

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const ARGV_URL = (() => {
  const i = process.argv.indexOf('--conversation');
  return i >= 0 ? (process.argv[i + 1] || '') : '';
})();

/* ===== ENV ===== */
const BOOM_USER   = process.env.BOOM_USER || '';
const BOOM_PASS   = process.env.BOOM_PASS || '';
const FROM_NAME   = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL = process.env.ROHIT_EMAIL || '';
const SMTP_HOST   = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_USER   = process.env.SMTP_USER || '';
const SMTP_PASS   = process.env.SMTP_PASS || '';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
// Optional: hard selector for real chat bubbles if you discover one
const MSG_SELECTOR = process.env.MSG_SELECTOR || '';

const log = (...a) => console.log(...a);

/* ===== artifacts ===== */
async function saveSnapshot(page, tag) {
  const fs = require('fs');
  try {
    await page.screenshot({ path: `/tmp/shot_${tag}.png`, fullPage: true });
    fs.writeFileSync(`/tmp/page_${tag}.html`, await page.content(), 'utf8');
    log('Saved artifacts for', tag);
  } catch (e) { log('Artifact save failed:', e.message); }
}

/* ===== email (465 → 587 fallback) ===== */
async function mkTx(port, secure) {
  return nodemailer.createTransport({
    host: SMTP_HOST, port, secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { minVersion: 'TLSv1.2' }
  });
}
async function sendAlertEmail({ url, lastSender, snippet }) {
  let tx;
  try { tx = await mkTx(465, true); await tx.verify(); }
  catch { tx = await mkTx(587, false); await tx.verify(); }

  const info = await tx.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: ROHIT_EMAIL,
    subject: 'SLA breach (>5 min): Boom guest message unanswered',
    html: `
      <p>Hi Rohit,</p>
      <p>A Boom guest message appears unanswered after 5 minutes.</p>
      <p>
        Conversation: <a href="${url}">Open in Boom</a><br/>
        Last sender detected: <b>${lastSender}</b><br/>
        Last message sample: <i>${(snippet || '').slice(0,140)}</i>
      </p>
      <p>– Automated alert</p>`
  });
  log('SMTP message id:', info.messageId);
}

/* ===== login ===== */
async function login(page) {
  const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="Email" i]';
  const passSel  = 'input[type="password"], input[name="password"], input[placeholder*="Password" i]';
  await page.goto('https://app.boomnow.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await saveSnapshot(page, 'login');

  const hasEmail = await page.$(emailSel);
  const hasPass  = await page.$(passSel);
  if (hasEmail && hasPass) {
    log('Login page detected, signing in…');
    await page.fill(emailSel, BOOM_USER);
    await page.fill(passSel,  BOOM_PASS);
    await Promise.all([
      page.click('button:has-text("Login"), button[type="submit"], input[type="submit"]'),
      page.waitForLoadState('networkidle').catch(()=>{})
    ]);
  }
}

/* ===== resolve tracking link → Boom URL ===== */
async function resolveToBoom(page, urlFromEmail) {
  if (!urlFromEmail) return null;
  if (/^https?:\/\/app\.boomnow\.com\//i.test(urlFromEmail)) return urlFromEmail;

  await page.goto(urlFromEmail, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.waitForURL(/app\.boomnow\.com/i, { timeout: 15000 }).catch(()=>{});
  if (/app\.boomnow\.com/i.test(page.url())) return page.url();

  const link = await page.$('a[href*="app.boomnow.com"]');
  if (link) {
    await Promise.all([ link.click(), page.waitForURL(/app\.boomnow\.com/i, { timeout: 15000 }).catch(()=>{}) ]);
    if (/app\.boomnow\.com/i.test(page.url())) return page.url();
  }
  return null;
}

/* ===== open the Messages tab robustly ===== */
async function openConversationUI(page) {
  // make sure tabs are on-screen
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  const tabLocators = [
    // aria/role first
    page.getByRole('tab', { name: /messages|conversation|chat|guest messages|الرسائل|محادثة|الدردشة/i }).first(),
    // vuetify tabs
    page.locator('.v-tabs .v-tab', { hasText: /messages|conversation|chat|الرسائل|محادثة|الدردشة/i }).first(),
    // generic text
    page.locator('text=/\\bMessages\\b/i').first(),
    page.locator('text=/\\bConversation\\b/i').first(),
    page.locator('text=/الرسائل/').first(),
  ];

  for (const loc of tabLocators) {
    try {
      if (await loc.count() > 0) {
        await loc.scrollIntoViewIfNeeded().catch(()=>{});
        await loc.click({ timeout: 1500 });
        await page.waitForTimeout(1200);
        await page.waitForLoadState('networkidle').catch(()=>{});
        return true;
      }
    } catch {}
  }
  // try finding a tablist then click any child that looks like messages
  const tabList = page.locator('[role="tablist"], .v-tabs').first();
  if (await tabList.count()) {
    const msgTab = tabList.locator(':scope *:text-matches("messages|الرسائل|محادثة|الدردشة", "i")').first();
    if (await msgTab.count()) {
      await msgTab.click().catch(()=>{});
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

/* ===== message detection ===== */

// avoid these containers/classes (KPIs, headers, helpers)
const BLACKLIST = [
  'v-messages__wrapper','v-messages__message',
  'snackbar','toast','tooltip','intercom',
  'v-tabs','v-tab','tabs','toolbar','header','summary','stats','kpi'
];

// prefer bubble-ish selectors; no generic mt-/mb- anymore
const CANDIDATES = [
  MSG_SELECTOR || '',
  '[data-testid="message"], [data-testid*="message"]',
  '.message-bubble,.chat-message,.message,.Message',
  '[role="tabpanel"] .v-list-item, [role="tabpanel"] .v-card__text, [role="tabpanel"] .v-sheet',
  '.v-list .v-list-item__content, .v-card .v-card__text'
].filter(Boolean);

function badClass(c){ c = (c||'').toLowerCase(); return BLACKLIST.some(b => c.includes(b)); }
function mostlyCaps(s){
  const letters = (s||'').replace(/[^A-Za-z]/g,''); if (letters.length<6) return false;
  const caps = letters.replace(/[^A-Z]/g,'').length; return caps/letters.length > 0.7;
}

function inferSender(meta){
  const c = (meta.cls||'').toLowerCase();
  if (/(agent|host|staff|team|outgoing|sent|yours|right|end)/.test(c)) return 'Agent';
  if (/(guest|customer|incoming|received|left|theirs|start)/.test(c)) return 'Guest';
  const a = [meta.style?.textAlign, meta.style?.justifyContent, meta.style?.alignSelf].join(' ').toLowerCase();
  if (/(right|flex-end|end)/.test(a)) return 'Agent';
  if (/(left|flex-start|start)/.test(a))  return 'Guest';
  if (typeof meta.centerX === 'number' && typeof meta.vw === 'number') {
    return meta.centerX > meta.vw*0.55 ? 'Agent' : 'Guest';
  }
  return 'Unknown';
}

async function scrollDeep(page){
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  // also scroll inner scroll areas (virtualized lists)
  await page.evaluate(() => {
    const xs = Array.from(document.querySelectorAll('*')).filter(n=>{
      const s = getComputedStyle(n);
      return (s.overflowY==='auto'||s.overflowY==='scroll') && n.scrollHeight>n.clientHeight;
    });
    for (const n of xs) n.scrollTop = n.scrollHeight;
  });
  await page.waitForTimeout(500);
}

function filterBubbles(raw){
  return raw.filter(m=>{
    if (!m.txt || m.txt.trim().length < 2) return false;
    if (mostlyCaps(m.txt)) return false;                // KPI cards
    if (badClass(m.cls)) return false;                  // tabs/toolbars/helpers
    if (m.inTabs) return false;
    if (m.height < 18) return false;                    // tiny
    if (m.width  > m.vw*0.95) return false;             // full-width bars
    if (m.bgTransparent && m.borderRadius < 6) return false; // not bubble-like
    return true;
  });
}

async function findMessages(page){
  const contexts = [page, ...page.frames()];
  const evalMeta = async (el) => el.evaluate(node=>{
    const r = node.getBoundingClientRect(), cs = getComputedStyle(node);
    const bg = cs.backgroundColor || '';
    const bgTransparent = /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)/i.test(bg) || bg==='transparent';
    let txt = ''; try { txt = (node.innerText||'').trim(); } catch {}
    return {
      txt, cls: node.getAttribute('class')||'',
      centerX: r.left + r.width/2, vw: innerWidth||document.documentElement.clientWidth||0,
      width: r.width, height: r.height,
      borderRadius: parseFloat(cs.borderRadius)||0,
      bgTransparent,
      style: { textAlign: cs.textAlign || '', alignSelf: cs.alignSelf || '',
               justifyContent: (node.parentElement ? getComputedStyle(node.parentElement).justifyContent : '') || '' },
      inTabs: !!node.closest('.v-tabs, .v-tab, [role="tablist"], header, nav')
    };
  });

  for (const sel of CANDIDATES) {
    let all=[]; for (const ctx of contexts){ const els = await ctx.$$(sel); for (const el of els) all.push(await evalMeta(el)); }
    const bubbles = filterBubbles(all);
    if (bubbles.length) return { nodes: bubbles, used: sel };
  }

  // very last resort: any text node, then filter bubble-ish
  for (const ctx of contexts){
    const els = await ctx.$$('xpath=//*[normalize-space(text())]');
    const all=[]; for (const el of els) all.push(await evalMeta(el));
    const bubbles = filterBubbles(all);
    if (bubbles.length) return { nodes: bubbles, used: 'XPATH' };
  }
  return { nodes: [], used: '(none)' };
}

async function detectStatus(page){
  await scrollDeep(page);
  const { nodes, used } = await findMessages(page);
  if (!nodes.length) {
    log('No message elements with text found (selector used: ' + used + ')');
    return { ok:false, reason:'no_selector' };
  }
  const last = nodes[nodes.length-1];
  const lastSender = inferSender(last);
  log('last message debug:', {
    class: last.cls, textSample: (last.txt||'').slice(0,160),
    centerX: last.centerX, vw: last.vw, dims:{w:last.width,h:last.height}, style:last.style
  });
  return {
    ok: true,
    isAnswered: lastSender === 'Agent',
    lastSender,
    snippet: last.txt || '',
    selUsed: used
  };
}

/* ===== main ===== */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await login(page);

  let finalUrl = await resolveToBoom(page, ARGV_URL);
  if (finalUrl) {
    log('Resolved Boom URL:', finalUrl);
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForLoadState('networkidle').catch(()=>{});
  }

  const opened = await openConversationUI(page);
  log('Opened conversation tab?', opened);
  await page.waitForTimeout(600);
  await saveSnapshot(page, 't2');

  const res = await detectStatus(page);
  log('Second check result:', res);

  // **Gate alerts**: only when confident we saw a last *Guest* message with text
  const shouldAlert = res.ok && !res.isAnswered && res.lastSender === 'Guest' && (res.snippet||'').trim().length > 0;

  if (shouldAlert) {
    await sendAlertEmail({ url: finalUrl || 'https://app.boomnow.com/', lastSender: res.lastSender, snippet: res.snippet });
  } else {
    log('No alert sent (not confident or not guest/unanswered).');
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
