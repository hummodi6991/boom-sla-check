// check.js
// Usage: node check.js --conversation "<URL>"

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const argvUrl = (() => {
  const i = process.argv.indexOf('--conversation');
  return i >= 0 ? (process.argv[i + 1] || '') : '';
})();

/* ========= ENV ========= */
const BOOM_USER    = process.env.BOOM_USER    || '';
const BOOM_PASS    = process.env.BOOM_PASS    || '';
const FROM_NAME    = process.env.FROM_NAME    || 'Oaktree Boom SLA Bot';
const ROHIT_EMAIL  = process.env.ROHIT_EMAIL  || '';
const SMTP_HOST    = process.env.SMTP_HOST    || 'smtp.gmail.com';
const SMTP_USER    = process.env.SMTP_USER    || '';
const SMTP_PASS    = process.env.SMTP_PASS    || '';
const SMTP_PORT    = Number(process.env.SMTP_PORT || 465);
const MSG_SELECTOR = process.env.MSG_SELECTOR || ''; // optional: exact bubble selector once known

const log = (...a) => console.log(...a);

/* ========= ARTIFACTS ========= */
async function saveSnapshot(page, tag) {
  const fs = require('fs');
  try {
    await page.screenshot({ path: `/tmp/shot_${tag}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`/tmp/page_${tag}.html`, html || '', 'utf8');
    log('Saved artifacts for', tag);
  } catch (e) { log('Artifact save failed:', e.message); }
}

/* ========= EMAIL (465 -> 587 fallback) ========= */
async function makeTransport(port, secure) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { minVersion: 'TLSv1.2' }
  });
}
async function sendAlertEmail({ lastSender, urlForEmail, snippet }) {
  let tx;
  try { tx = await makeTransport(465, true); await tx.verify(); }
  catch(e){ log('465 failed → 587 STARTTLS:', e.message); tx = await makeTransport(587, false); await tx.verify(); }

  const info = await tx.sendMail({
    from: `"${FROM_NAME}" <${SMTP_USER}>`,
    to: ROHIT_EMAIL,
    subject: 'SLA breach (>5 min): Boom guest message unanswered',
    html: `
      <p>Hi Rohit,</p>
      <p>A Boom guest message appears unanswered after 5 minutes.</p>
      <p>
        Conversation: <a href="${urlForEmail}">Open in Boom</a><br/>
        Last sender detected: <b>${lastSender || 'Unknown'}</b><br/>
        Last message sample: <i>${(snippet || '').slice(0,140)}</i>
      </p>
      <p>– Automated alert</p>`
  });
  log('SMTP message id:', info.messageId);
}

/* ========= LOGIN ========= */
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
  } else {
    log('Login fields not found—already authenticated?');
  }
}

/* ========= URL RESOLUTION (follow tracker -> Boom) ========= */
async function resolveToBoom(page, urlFromEmail) {
  if (!urlFromEmail) return null;
  if (/^https?:\/\/app\.boomnow\.com\//i.test(urlFromEmail)) return urlFromEmail;

  log('Following tracking URL to resolve final Boom link…');
  await page.goto(urlFromEmail, { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.waitForURL(/app\.boomnow\.com/i, { timeout: 15000 }).catch(()=>{});
  if (/app\.boomnow\.com/i.test(page.url())) return page.url();

  const link = await page.$('a[href*="app.boomnow.com"]');
  if (link) {
    await Promise.all([ link.click(), page.waitForURL(/app\.boomnow\.com/i, { timeout: 15000 }).catch(()=>{}) ]);
    if (/app\.boomnow\.com/i.test(page.url())) return page.url();
  }
  log('Could not resolve a Boom URL from the tracker; staying on current page.');
  return null;
}

/* ========= OPEN THE CHAT/MESSAGES TAB ========= */
async function openConversationUI(page) {
  // Try very tolerant locators (English + Arabic)
  const candidates = [
    // role=tab if present
    { type: 'role', name: /messages|guest messages|conversation|chat|الرسائل|محادثة|الدردشة|مراسلات/i },
    // text locators
    { type: 'text', sel: 'text=Messages' },
    { type: 'text', sel: 'text=Conversation' },
    { type: 'text', sel: 'text=Guest Messages' },
    { type: 'text', sel: 'text=Chat' },
    { type: 'text', sel: 'text=الرسائل' },
    { type: 'text', sel: 'text=المحادثة' },
    { type: 'text', sel: 'text=الدردشة' },
    // buttons/links with text
    { type: 'css', sel: 'button:has-text("Messages")' },
    { type: 'css', sel: 'a:has-text("Messages")' },
    { type: 'css', sel: 'button:has-text("Conversation")' },
    { type: 'css', sel: 'a:has-text("Conversation")' }
  ];

  for (const c of candidates) {
    try {
      let loc;
      if (c.type === 'role') {
        loc = page.getByRole('tab', { name: c.name }).first();
      } else if (c.type === 'text') {
        loc = page.locator(c.sel).first();
      } else {
        loc = page.locator(c.sel).first();
      }
      if (await loc.count() > 0) {
        await loc.click({ timeout: 1500 }).catch(()=>{});
        await page.waitForTimeout(1200);
        await page.waitForLoadState('networkidle').catch(()=>{});
        return true;
      }
    } catch {}
  }
  return false;
}

/* ========= MESSAGE DETECTION ========= */
const BLACKLIST = ['v-messages__wrapper','v-messages__message','snackbar','toast','tooltip','intercom'];
const CANDIDATES = [
  MSG_SELECTOR || '',
  '[data-testid="message"]',
  '[data-testid*="message"]',
  '.message-bubble','.message-row','.chat-message','.Message',
  '[class*="messages"] [class*="message"]',
  'li[role="listitem"]',
  // generic “bubble-ish” wrappers (filtered later)
  'div[class*="mt-"], div[class*="mb-"]',
  'div[class*="bubble"]'
].filter(Boolean);

function badClass(cls){ const c=(cls||'').toLowerCase(); return BLACKLIST.some(b => c.includes(b)); }

function inferSenderHeuristic(meta) {
  const c = (meta.cls || '').toLowerCase();
  if (/(agent|host|staff|team|outgoing|sent|yours|right|end)/.test(c)) return 'Agent';
  if (/(guest|customer|incoming|received|left|theirs|start)/.test(c))  return 'Guest';

  const style = (meta.style || {});
  const alignHints = [style.textAlign, style.justifyContent, style.alignSelf].join(' ').toLowerCase();
  if (/(right|flex-end|end)/.test(alignHints)) return 'Agent';
  if (/(left|flex-start|start)/.test(alignHints)) return 'Guest';

  if (typeof meta.centerX === 'number' && typeof meta.vw === 'number') {
    return (meta.centerX > meta.vw * 0.55) ? 'Agent' : 'Guest';
  }
  return 'Unknown';
}

async function scrollDeep(page){
  // scroll page
  await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.scrollTo(0, 0); });

  // try scrolling any scrollable panels (virtualized lists)
  await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('*')).filter(n => {
      const s = getComputedStyle(n);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight;
    });
    for (const n of nodes) n.scrollTop = n.scrollHeight;
  });
  await page.waitForTimeout(600);
}

async function findMessages(page){
  const contexts = [page, ...page.frames()];
  log(`Searching ${contexts.length} contexts (page + ${contexts.length-1} frames)…`);

  for (const sel of CANDIDATES) {
    let found = [];
    for (const ctx of contexts) {
      const els = await ctx.$$(sel);
      for (const el of els) {
        const meta = await el.evaluate((node) => {
          let txt = '';
          try { txt = (node.innerText || '').trim(); } catch {}
          const r = node.getBoundingClientRect();
          const cs = getComputedStyle(node);
          return {
            txt,
            cls: node.getAttribute('class') || '',
            centerX: r.left + r.width / 2,
            vw: window.innerWidth || document.documentElement.clientWidth || 0,
            style: {
              textAlign: cs.textAlign || '',
              justifyContent: (node.parentElement ? getComputedStyle(node.parentElement).justifyContent : '') || '',
              alignSelf: cs.alignSelf || ''
            }
          };
        });
        if ((meta.txt || '').length > 1 && !badClass(meta.cls)) found.push(meta);
      }
    }
    if (found.length) return { nodes: found, used: sel };
  }

  // Fallback XPATH
  const XPATH = 'xpath=//*[contains(translate(@class,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"message") and not(contains(@class,"v-messages"))]//*[normalize-space(text())]';
  for (const ctx of contexts) {
    const els = await ctx.$$(XPATH);
    const out = [];
    for (const el of els) {
      const meta = await el.evaluate((node) => {
        let txt = '';
        try { txt = (node.innerText || '').trim(); } catch {}
        const r = node.getBoundingClientRect();
        const cs = getComputedStyle(node);
        return {
          txt,
          cls: node.getAttribute('class') || '',
          centerX: r.left + r.width / 2,
          vw: window.innerWidth || document.documentElement.clientWidth || 0,
          style: {
            textAlign: cs.textAlign || '',
            justifyContent: (node.parentElement ? getComputedStyle(node.parentElement).justifyContent : '') || '',
            alignSelf: cs.alignSelf || ''
          }
        };
      });
      if ((meta.txt || '').length > 1 && !badClass(meta.cls)) out.push(meta);
    }
    if (out.length) return { nodes: out, used: 'XPATH' };
  }

  return { nodes: [], used: '(none)' };
}

async function detectStatus(page){
  await scrollDeep(page);
  const { nodes, used } = await findMessages(page);

  if (!nodes.length) {
    log('No message elements with text found (selector used: ' + used + ')');
    return { isAnswered:false, lastSender:'Unknown', reason:'no_selector', selUsed: used, snippet:'' };
  }

  const last = nodes[nodes.length - 1];
  const lastSender = inferSenderHeuristic(last);

  log('last message debug:', {
    class: last.cls || '(n/a)',
    textSample: (last.txt || '').slice(0, 120),
    centerX: last.centerX, vw: last.vw,
    style: last.style
  });

  return {
    isAnswered: lastSender === 'Agent',
    lastSender,
    reason: 'geo-heuristic',
    selUsed: used,
    snippet: last.txt || ''
  };
}

/* ========= MAIN ========= */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1) Login so we’re authenticated
  await login(page);

  // 2) Follow the provided link until we end up on Boom
  let finalUrl = await resolveToBoom(page, argvUrl);
  if (finalUrl) {
    log('Resolved Boom URL:', finalUrl);
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await page.waitForLoadState('networkidle').catch(()=>{});
  }

  // 3) Try to open the conversation/messages tab
  const opened = await openConversationUI(page);
  log('Opened conversation tab?', opened);
  await page.waitForTimeout(800);
  await saveSnapshot(page, 't2');

  // 4) Detect status
  const result = await detectStatus(page);
  log('Second check result:', result);

  // 5) Email if unanswered
  if (!result.isAnswered) {
    await sendAlertEmail({
      lastSender: result.lastSender,
      urlForEmail: finalUrl || 'https://app.boomnow.com/',
      snippet: result.snippet
    });
  } else {
    log('No alert needed.');
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
