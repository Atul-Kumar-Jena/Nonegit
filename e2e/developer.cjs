/**
 * Registration with Google Authenticator, end to end in the browser (demo-mode server from
 * /tmp/demo-reset.sh, whose log prints the developer's setup code):
 *   developer links Google Authenticator once → creates + verifies an institution → its main admin
 *   signs in to Attendly Institute with the setup code → adds a professor (gets their setup code) →
 *   the developer signs in again with just the authenticator code.
 *   OUT=/tmp/shots-dev NODE_PATH=... node e2e/developer.cjs
 */
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const OUT = process.env.OUT || '/tmp/shots-dev';
fs.mkdirSync(OUT, { recursive: true });
const INSTITUTE = 'http://localhost:8082';
const DEVELOPER = 'http://localhost:8083';
const SERVER_LOG = process.env.SERVER_LOG || '/tmp/server-demo.log';
const ERRORS = [];
let n = 0;
let lastPage;
const shot = (p, name) => p.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png` });
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    if (lastPage) await lastPage.screenshot({ path: `${OUT}/FAILED-${String(++n).padStart(2, '0')}.png` }).catch(() => {});
    ERRORS.push(`${name}: ${err.message.split('\n')[0]}`);
  }
};
const newPage = async (browser, label) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  lastPage = p;
  p.on('pageerror', (e) => ERRORS.push(`${label} page error: ${e.message}`));
  return p;
};

/** Google Authenticator, in 12 lines (RFC 6238, SHA-1, 30 s, 6 digits). */
function totp(secretB32, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const secretOnPage = async (p) => (await p.locator('body').innerText()).match(/\b([A-Z2-7]{4}(?: [A-Z2-7]{4}){5,})\b/)[1].replace(/ /g, '');
const typeCode = (p, code) => p.locator('input[autocomplete="one-time-code"]').last().fill(code);
/** Waits into a fresh 30-second window, so a code isn't reused (the server refuses replays). */
const nextWindow = () => new Promise((r) => setTimeout(r, 30_500 - (Date.now() % 30_000)));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let dev, devSecret, instCode, adminCode, adminSecret;

  await step('The server log holds the developer’s one-time setup code', async () => {
    const log = fs.readFileSync(SERVER_LOG, 'utf8');
    const m = log.match(/sign-in ID (\S+) · setup code ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/);
    if (!m) throw new Error('no developer setup code in the server log');
    dev = { id: m[1], code: m[2] };
  });

  let d;
  await step('Developer app: first-time setup links Google Authenticator and opens the console', async () => {
    d = await newPage(browser, 'developer');
    await d.goto(DEVELOPER);
    await d.getByText('First-time setup').click({ timeout: 60_000 });
    await d.getByLabel('Sign-in ID', { exact: true }).fill(dev.id);
    await d.getByLabel('Setup code', { exact: true }).fill(dev.code.toLowerCase().replace(/-/g, ' '));
    await shot(d, 'dev-setup-code');
    await d.getByRole('button', { name: 'Continue' }).click();
    await d.getByText('1 · Add Attendly to Google Authenticator').waitFor({ timeout: 20_000 });
    devSecret = await secretOnPage(d);
    await shot(d, 'dev-authenticator');
    await typeCode(d, totp(devSecret));
    await d.getByRole('button', { name: 'Bind this device' }).click({ timeout: 30_000 });
    await d.getByText('Kill switches').waitFor({ timeout: 30_000 });
    await d.getByText('ROOT').first().waitFor();
    await shot(d, 'dev-console');
  });

  await step('Creates an institution and gets its main admin’s setup code', async () => {
    await d.getByRole('tab', { name: 'Tenants' }).click();
    await d.getByRole('button', { name: 'New' }).click();
    await d.getByPlaceholder('e.g. Green Valley College').fill('Riverside College');
    await d.getByPlaceholder('e.g. Dr. Anita Rao (Principal)').fill('Dr. Kavya Menon');
    await d.getByPlaceholder('principal@greenvalley.edu').fill('principal@riverside.edu');
    await d.getByRole('button', { name: 'Create institution' }).click();
    await d.getByText('Setup code for Dr. Kavya Menon').waitFor({ timeout: 20_000 });
    const txt = await d.locator('body').innerText();
    adminCode = txt.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\b/)[1];
    await d.getByRole('button', { name: 'Verify institution' }).click();
    await d.getByRole('button', { name: 'Remove verification' }).waitFor({ timeout: 20_000 });
    instCode = ((await d.locator('body').innerText()).match(/\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g) || []).find((c) => c !== 'DEMO-2026');
    if (!instCode) throw new Error('no institution code on screen');
    await shot(d, 'dev-institution-created');
  });

  let a;
  await step('The main admin signs in to Attendly Institute with the setup code and Google Authenticator', async () => {
    a = await newPage(browser, 'institute');
    await a.goto(INSTITUTE);
    await a.getByPlaceholder('7F3A-91C2').fill(instCode, { timeout: 60_000 });
    await a.getByRole('button', { name: 'Find institution' }).click();
    await a.getByRole('button', { name: /^Continue to Riverside College/ }).click();
    await a.getByText('First time? Sign in with a setup code').click();
    await a.getByLabel('Sign-in ID', { exact: true }).fill('principal@riverside.edu');
    await a.getByLabel('Setup code', { exact: true }).fill(adminCode);
    await a.getByRole('button', { name: 'Continue' }).click();
    await a.getByText('Dr. Kavya Menon').first().waitFor({ timeout: 20_000 });
    adminSecret = await secretOnPage(a);
    await shot(a, 'admin-authenticator');
    await typeCode(a, totp(adminSecret));
    await a.getByRole('button', { name: 'Bind this device' }).click({ timeout: 30_000 });
    await a.getByRole('tab', { name: 'More' }).waitFor({ timeout: 30_000 });
    await shot(a, 'admin-home');
  });

  await step('The main admin adds a professor and gets their setup code to share', async () => {
    await a.getByRole('tab', { name: 'More' }).click();
    await a.getByText('People & roles').first().click();
    await a.getByRole('tab', { name: 'Professors' }).click();
    await a.waitForTimeout(900);
    await a.getByRole('button', { name: 'Add', exact: true }).click();
    await a.getByText('Admin', { exact: true }).last().waitFor({ timeout: 20_000 }); // only the main admin can add admins
    await a.getByPlaceholder('As on the ID card').fill('Prof. Arjun Pillai');
    await a.getByPlaceholder('name@college.edu').fill('arjun@riverside.edu');
    await a.getByRole('button', { name: 'Add professor' }).click();
    await a.getByText('Setup code for Prof. Arjun Pillai').waitFor({ timeout: 20_000 });
    await a.getByText('Share instructions').waitFor();
    await shot(a, 'professor-setup-code');
  });

  await step('The developer signs in again with only the authenticator code (ID remembered)', async () => {
    lastPage = d;
    await d.goBack();
    await d.getByRole('tab', { name: 'Profile' }).click({ timeout: 20_000 });
    await d.getByRole('button', { name: 'Sign out' }).click();
    await d.getByText('Code from Google Authenticator').waitFor({ timeout: 30_000 });
    if ((await d.getByLabel('Developer sign-in ID').inputValue()) !== dev.id) throw new Error('sign-in ID not remembered');
    await nextWindow();
    await typeCode(d, totp(devSecret));
    await d.getByText('Kill switches').waitFor({ timeout: 30_000 });
    await shot(d, 'dev-signed-in-again');
  });

  await browser.close();
  console.log(`\nERRORS: ${JSON.stringify(ERRORS, null, 1)}`);
  process.exit(ERRORS.length ? 1 : 0);
})();
