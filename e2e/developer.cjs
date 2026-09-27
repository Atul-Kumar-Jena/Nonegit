/**
 * Developer app in testing mode (demo server): it opens straight into the console, adds a test
 * institution, verifies it, and that institution's admin signs in to Attendly Institute with the code.
 *   OUT=/tmp/shots-dev NODE_PATH=... node e2e/developer.cjs
 */
const { chromium } = require('playwright');
const OUT = process.env.OUT || '/tmp/shots-dev';
require('fs').mkdirSync(OUT, { recursive: true });
const INSTITUTE = 'http://localhost:8082';
const DEVELOPER = 'http://localhost:8083';
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
const page = async (browser, label) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  lastPage = p;
  p.on('pageerror', (e) => ERRORS.push(`${label} page error: ${e.message}`));
  return p;
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let dev;
  let code = '';

  await step('The developer app opens straight into the console (no email, no code, no taps)', async () => {
    dev = await page(browser, 'developer');
    await dev.goto(DEVELOPER);
    await dev.getByText('Kill switches').waitFor({ timeout: 60_000 });
    await dev.getByText('SANDBOX').first().waitFor();
    await shot(dev, 'console');
  });

  await step('Adds a test institution with a test admin address', async () => {
    await dev.getByRole('tab', { name: 'Tenants' }).click();
    await dev.getByRole('button', { name: 'New' }).click();
    await dev.getByPlaceholder('e.g. Green Valley College').fill('Riverside Test College');
    await dev.getByRole('button', { name: 'Use a test admin address' }).click();
    await dev.getByText(/admin\.riverside\.test\.college@demo\.attendly\.app/).or(dev.locator('input[value="admin.riverside.test.college@demo.attendly.app"]')).first().waitFor({ timeout: 5000 });
    await shot(dev, 'new-institution');
    await dev.getByRole('button', { name: 'Create institution' }).click();
    await dev.getByText('Pending verification', { exact: false }).first().waitFor({ timeout: 20_000 });
    await dev.getByText('tenant:riverside-test-college').locator('visible=true').first().waitFor();
  });

  await step('Verifies it and reads its code', async () => {
    await dev.getByRole('button', { name: 'Verify institution' }).click();
    await dev.getByRole('button', { name: 'Remove verification' }).waitFor({ timeout: 20_000 });
    const txt = await dev.locator('body').innerText();
    code = (txt.match(/\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g) || []).find((c) => c !== 'DEMO-2026') || '';
    if (!code) throw new Error('no institution code on screen');
    await shot(dev, 'verified');
  });

  await step('The new institution’s admin signs in to Attendly Institute with that code', async () => {
    const p = await page(browser, 'institute');
    await p.goto(INSTITUTE);
    await p.getByPlaceholder('7F3A-91C2').waitFor({ timeout: 60_000 });
    await p.getByPlaceholder('7F3A-91C2').fill(code);
    await p.getByRole('button', { name: 'Find institution' }).click();
    await p.getByRole('button', { name: /^Continue to Riverside Test College/ }).click();
    await p.getByPlaceholder('you@iit.ac.in').fill('admin.riverside.test.college@demo.attendly.app');
    await p.getByRole('button', { name: 'Send OTP' }).click();
    await p.getByRole('button', { name: 'Bind this device' }).click({ timeout: 30_000 });
    await p.getByText(/Riverside Test College|Set up|Timetable|Today/).first().waitFor({ timeout: 30_000 });
    await shot(p, 'new-admin-signed-in');
  });

  await step('The institutions list shows it as a test (Demo) institution, never a real one', async () => {
    await dev.goto(`${DEVELOPER}/tenants`);
    await dev.getByText('Riverside Test College').first().waitFor({ timeout: 30_000 });
    if (await dev.getByText('Green Valley College').count()) throw new Error('testing console sees a real institution');
    await shot(dev, 'tenants');
  });

  await step('Email sign-in is still there, and it refuses a student', async () => {
    const p = await page(browser, 'developer-email');
    await p.goto(DEVELOPER);
    await p.getByText('Kill switches').waitFor({ timeout: 60_000 });
    await p.getByRole('tab', { name: 'Profile' }).click();
    await p.getByRole('button', { name: /Sign out/ }).first().click();
    const confirm = p.getByRole('button', { name: /^Sign out$/ });
    if (await confirm.count()) await confirm.last().click().catch(() => {});
    await p.getByText('Sign in with a developer email instead').click({ timeout: 30_000 });
    await p.getByPlaceholder('you@iit.ac.in').fill('vikram@demo.attendly.app');
    await p.getByRole('button', { name: 'Send OTP' }).click();
    await p.getByText(/developers only/).first().waitFor({ timeout: 20_000 });
    await shot(p, 'refuses-student');
  });

  await browser.close();
  console.log(`\nERRORS: ${JSON.stringify(ERRORS, null, 1)}`);
  process.exit(ERRORS.length ? 1 : 0);
})();
