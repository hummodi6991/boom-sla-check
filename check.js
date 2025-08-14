// check.js
const { chromium } = require('playwright');
const fs = require('fs');
const nodemailer = require('nodemailer');

const conversationUrl = process.env.CONVERSATION_URL || process.argv[2];
const boomUser = process.env.BOOM_USER;
const boomPass = process.env.BOOM_PASS;
const toEmail   = process.env.ROHIT_EMAIL;
const fromEmail = process.env.SMTP_USER;
const fromName  = process.env.FROM_NAME || 'Oaktree Boom SLA Bot';

if (!conversationUrl) {
  console.error('No conversation URL provided.');
  process.exit(1);
}

function stampName(name){ return `${name}_${Date.now()}`; }
async function savePageArtifacts(page, label){
  try {
    const shot = `/tmp/${stampName('shot_'+label)}.png`;
    const html = `/tmp/${stampName('page_'+label)}.html`;
    await page.screenshot({ path: shot, fullPage: true });
    const content = await page.content();
    fs.writeFileSync(html, content, 'utf8');

    const frames = page.frames();
    for (let i = 0; i < frames.length; i++) {
      try {
        const fhtml = await frames[i].content();
        fs.writeFileSync(`/tmp/${stampName(`frame_${i}_${label}`)}.html`, fhtml, 'utf8');
      } catch {}
    }
    console.log(`Saved artifacts for ${label}`);
  } catch (e) {
    console.warn('Artifact save failed:', e.message);
  }
}

async function loginIfNeeded(page){
  const onLogin = await page.locator('text=Dashboard Login').first().isVisible().catch(() => false);
  if (onLogin) {
    console.log('Login page detected, signing in…');
    await page.locator('input[type="email"], input[name="email"], input[placeholder*="Email" i]').fill(boomUser);
    await page.locator('input[type="password"], input[name="password"], input[placeholder*="Password" i]').fill(boomPass);
    await page.locator('button:has-text("Login"), input[type="submit"][value="Login"]').click();
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    if (!page.url().includes('/guest-experience/')) {
      await page.goto(conversationUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    }
  }
}

function pickLastMessageCandidate(nodeInfos){
  const badClasses = ['v-messages__wrapper'];
  const goodHints = ['chat', 'message', 'bubble', 'messages__item', 'msg', 'listitem'];
  let best = null, bestScore = -1;
  for (const n of nodeInfos){
    const cls = (n.class || '').toLowerCase();
    if (badClasses.some(b => cls.includes(b))) continue;
    let score = 0;
    for (const h of goodHints) if (cls.includes(h)) score += 2;
    if ((n.textSample || '').trim()) score += 1;
    if (score > bestScore){ best = n; bestScore = score; }
  }
  return best;
}

async function scanForMessages(page){
  const selectors = [
    '[class*="messages"] [class*="message"]',
    'div[class*="chat"] div[class*="message"]',
    'li[class*="message"], li[class*="msg"]',
    '[data-testid*="message"]',
    '.v-list .v-list-item, .v-virtual-scroll__item'
  ];

  const contexts = [page, ...page.frames()];
  console.log(`🔎 Searching ${contexts.length} contexts (page + ${contexts.length-1} frames)…`);

  let found = [];
  for (const ctx of contexts){
    for (const sel of selectors){
      const els = await ctx.$$(sel);
      for (const el of els){
        const cls = (await el.getAttribute('class')) || '';
        const txt = ((await el.innerText()).trim()).slice(0, 120);
        found.push({ class: cls, textSample: txt });
      }
    }
  }

  if (found.length){
    console.log(`✅ Found ${found.length} nodes with message-like selectors.`);
  } else {
    console.warn('⚠️ No message elements found with known selectors.');
  }

  const last = pickLastMessageCandidate(found);
  console.log('last message debug:', last || { none: true });

  return {
    result: {
      isAnswered: false,         // heuristic placeholder until we map exact DOM
      lastSender: 'Unknown',
      reason: found.length ? 'heuristic' : 'no_selector'
    },
    foundCount: found.length
  };
}

async function sendEmail(subject, html){
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const info = await transporter.sendMail({
    from: { name: fromName, address: fromEmail },
    to: toEmail,
    subject,
    html
  });
  console.log('✉️  SMTP response id:', info.messageId);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(conversationUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  await savePageArtifacts(page, 't1');

  await loginIfNeeded(page);
  await savePageArtifacts(page, 't2');

  const { result } = await scanForMessages(page);
  console.log('Second check result:', result);

  if (!result.isAnswered) {
    const subject = 'SLA breach (>5 min): Boom guest message unanswered';
    const body = `
      <p>Hi Rohit,</p>
      <p>A Boom guest message appears unanswered after 5 minutes.</p>
      <p>Conversation: <a href="${conversationUrl}">Open in Boom</a><br/>
      Last sender detected: ${result.lastSender}</p>
      <p>– Automated alert</p>`;
    console.log(`Sending email to *** from ***…`);
    await sendEmail(subject, body);
  }

  await browser.close();
})();
