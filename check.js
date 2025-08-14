// check.js – Boom SLA checker (Playwright + SMTP)
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

/* ---------- CLI ---------- */
const ARGV_URL = (() => {
  const i = process.argv.indexOf('--conversation');
  return i >= 0 ? (process.argv[i + 1] || '') : '';
})();

/* ---------- ENV ---------- */
const BOOM_USER   = process.env.BOOM_USER || '';
const BOOM_PASS   = process.env.BOOM_PASS || '';
const FROM_NAME   = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL = process.env.ROHIT_EMAIL || '';
const SMTP_HOST   = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_USER   = process.env.SMTP_USER || '';
const SMTP_PASS   = process.env.SMTP_PASS || '';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 465);
const MSG_SELECTOR = process.env.MSG_SELECTOR || ''; // optional: overrides detection

const log = (...a) => console.log(...a);

/* ---------- helpers / artifacts ---------- */
async function saveSnapshot(page, tag) {
  const fs = require('fs');
  try {
    await page.screenshot({ path: `/tmp/shot_${tag}.png`, fullPage: true });
    fs.writeFileSync(`/tmp/page_${tag}.html`, await page.content(), 'utf8');
    log('Saved artifacts for', tag);
  } catch (e) { log('Artifact save failed:', e.message); }
}

async function mkTx(port, secure) {
  return nodemailer.createTransport({
    host: SMTP_HOST, port, secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { minVersion: 'TLSv1.2' },
  });
}
async function sendAlertEmail({ url, lastSender, snippet }) {
  let tx;
  try { tx = await mkTx(465, true);  await tx.verify(); }
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
        Last message sample: <i>${(snippet || '').slice(0, 200)}</i>
      </p>
      <p>– Automated alert</p>`
  });
  log('SMTP message id:', info.messageId);
}

/* ---------- login ---------- */
async function login(page) {
  const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="Email" i]';
  const passSel  = 'input[type="password"], input[name="password"], input[placeholder*="Password" i]';

  await page.goto('https://app.boomnow.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await saveSnapshot(page, 'login');

  if (await page.$(emailSel) && await page.$(passSel)) {
    log('Login page detected, signing in…');
    await page.fill(emailSel, BOOM_USER);
    await page.fill(passSel,  BOOM_PASS);
    await Promise.all([
      page.click('button:has-text("Login"), button[type="submit"], input[type="submit"]'),
      page.waitForLoadState('networkidle').catch(()=>{}),
    ]);
  }
}

/* ---------- resolve tracking link → Boom URL ---------- */
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

/* ---------- open Messages tab robustly ---------- */
async function openConversationUI(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  const tabLocs = [
    page.getByRole('tab', { name: /messages|conversation|chat|guest messages|الرسائل|محادثة|الدردشة/i }).first(),
    page.locator('.v-tabs .v-tab', { hasText: /messages|conversation|chat|الرسائل|محادثة|الدردشة/i }).first(),
    page.locator('text=/\\bMessages\\b/i').first(),
    page.locator('text=/الرسائل/').first(),
  ];
  for (const loc of tabLocs) {
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
  // generic tablist fallback
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

/* ---------- message detection ---------- */

// Ignore obvious KPI/headers in Arabic/English that fooled us before
const TEXT_BLACKLIST = [
  /UNANSWERED/i, /AI ESCALATIONS/i, /AI ACTIVE/i, /RESERVED/i,
  /ACTIVE LEADS/i, /FOLLOW UPS/i, /MY TICKETS/i,
  /AWAITING PAYMENT/i, /RECENTLY CONFIRMED/i, /^\s*ALL\s*$/i,
  /مؤكدة/i, /غير مجاب/i, /المدفوعات/i, /الحجوزات/i
];

// any element inside the active tabpanel that looks like a bubble or list item
const CANDIDATES = [
  MSG_SELECTOR || '',                              // your override (repo secret)
  '[role="tabpanel"] .v-virtual-scroll__item',     // Vuetify virtual list items
  '[role="tabpanel"] .v-list-item',                // Vuetify list items
  '[role="tabpanel"] .v-card .v-card__text',       // text inside cards
  '[role="tabpanel"] [class*="message"]',
  '[role="tabpanel"] [class*="bubble"]',
  '[role="tabpanel"] [class*="chat"]',
  // broad fallbacks (if tabpanel role missing)
  '.v-virtual-scroll__item', '.v-list-item', '.v-card__text',
  '[class*="message"]', '[class*="bubble"]', '[class*="chat"]',
].filter(Boolean);

function mostlyCaps(s) {
  const letters = (s||'').replace(/[^A-Za-zأ-ي]/g, '');
  if (letters.length < 6) return false;
  const caps = letters.replace(/[^A-Z]/g, '').length;
  return caps / letters.length > 0.7;
}

function badText(s) { return TEXT_BLACKLIST.some(rx => rx.test(s)); }

function inferSender(meta) {
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

async function scrollDeep(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const xs = Array.from(document.querySelectorAll('*')).filter(n=>{
      const s = getComputedStyle(n);
      return (s.overflowY==='auto'||s.overflowY==='scroll') && n.scrollHeight>n.clientHeight;
    });
    for (const n of xs) n.scrollTop = n.scrollHeight;
  });
  await page.waitForTimeout(500);
}

async function evaluateMeta(el) {
  return el.evaluate(node => {
    const r = node.getBoundingClientRect(), cs = getComputedStyle(node);
    let txt = ''; try { txt = (node.innerText || '').trim(); } catch {}
    return {
      txt,
      cls: node.getAttribute('class') || '',
      centerX: r.left + r.width/2,
      vw: innerWidth || document.documentElement.clientWidth || 0,
      width: r.width, height: r.height,
      style: {
        textAlign: cs.textAlign || '',
        alignSelf: cs.alignSelf || '',
        justifyContent: (node.parentElement ? getComputedStyle(node.parentElement).justifyContent : '') || ''
      },
      inHeader: !!node.closest('.v-tabs, .v-tab, [role="tablist"], header, nav')
    };
  });
}

function filterBubbles(nodes) {
  return nodes.filter(m => {
    if (!m.txt || m.txt.trim().length < 3) return false;
    if (badText(m.txt)) return false;       // throw away KPI headings/cards
    if (mostlyCaps(m.txt)) return false;    // VERY shouty blocks → likely KPIs
    if (m.inHeader) return false;           // not inside tabs/headers
    if (m.height < 14) return false;        // too tiny to be a bubble
    return true;
  });
}

async function findMessages(page) {
  const contexts = [page, ...page.frames()];
  // try each candidate selector, inside page and frames
  for (const sel of CANDIDATES) {
    let all = [];
    for (const ctx of contexts) {
      const els = await ctx.$$(sel);
      for (const el of els) all.push(await evaluateMeta(el));
    }
    const bubbles = filterBubbles(all);
    if (bubbles.length) return { nodes: bubbles, used: sel };
  }
  // ultra-broad fallback: any element with non-empty text, then filter
  for (const ctx of contexts) {
    const els = await ctx.$$('xpath=//*[normalize-space(text())]');
    const all = [];
    for (const el of els) all.push(await evaluateMeta(el));
    const bubbles = filterBubbles(all);
    if (bubbles.length) return { nodes: bubbles, used: 'XPATH' };
  }
  return { nodes: [], used: '(none)' };
}

async function detectStatus(page) {
  await scrollDeep(page);
  const { nodes, used } = await findMessages(page);
  if (!nodes.length) {
    log('No message elements with text found (selector used: ' + used + ')');
    return { ok:false, reason:'no_selector' };
  }
  const last = nodes[nodes.length - 1];
  const lastSender = inferSender(last);
  log('last message debug:', {
    selectorUsed: used,
    class: last.cls, textSample: (last.txt||'').slice(0, 180),
    style: last.style, dims: { w: last.width, h: last.height }
  });
  return {
    ok: true,
    isAnswered: lastSender === 'Agent',
    lastSender,
    snippet: last.txt || '',
    selUsed: used
  };
}

/* ---------- main ---------- */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await login(page);

  const finalUrl = await resolveToBoom(page, ARGV_URL);
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

  const shouldAlert =
    res.ok &&
    !res.isAnswered &&
    res.lastSender === 'Guest' &&
    (res.snippet || '').trim().length > 0;

  if (shouldAlert) {
    await sendAlertEmail({
      url: finalUrl || 'https://app.boomnow.com/',
      lastSender: res.lastSender,
      snippet: res.snippet
    });
  } else {
    log('No alert sent (not confident or not guest/unanswered).');
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
