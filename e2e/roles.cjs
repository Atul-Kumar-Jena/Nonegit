/**
 * Roles rehearsal (demo server, see README.md): a professor has no planner; the admin grants
 * "Planner & cover" from People & roles; the professor now has the planner and the cover board;
 * the admin takes it away again. Also: the institution code is shown to staff in More.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = process.env.OUT || '/tmp/shots-roles';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const INSTITUTE = 'http://localhost:8082';
const ERRORS = [];
let n = 0;
let lastPage = null;
const shot = async (page, name) => (lastPage = page).screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png` });
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

async function demoSignIn(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  lastPage = page;
  page.on('pageerror', (e) => ERRORS.push(`${name} page error: ${e.message}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(INSTITUTE);
  // Institute app: the first time, the institution code (the demo institute has a one-tap button).
  const demoInst = page.getByRole('button', { name: /Try the demo/ });
  await Promise.race([demoInst.waitFor({ timeout: 60_000 }), page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 })]).catch(() => {});
  if (await demoInst.isVisible().catch(() => false)) {
    await demoInst.click();
    await page.getByText('Verified by Attendly').waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Continue to / }).click();
  }
  await page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: new RegExp(`Sign in as ${name}`) }).click();
  await page.getByRole('button', { name: 'Bind this device' }).click();
  await page.getByText('Classes', { exact: true }).last().waitFor({ timeout: 30_000 });
  return { ctx, page };
}
const visible = (page, text, exact = true) => page.getByText(text, { exact }).locator('visible=true').first();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let admin, prof;
  const more = async (p) => {
    await p.getByText('More', { exact: true }).last().click();
    await visible(p, 'All features').waitFor({ timeout: 20_000 });
  };

  await step('A plain professor: “Professor” badge, no planner or cover tiles', async () => {
    prof = (await demoSignIn(browser, 'Dr. S. Banerjee')).page;
    await more(prof);
    await visible(prof, /Professor: your classes, batches and reports/, false).waitFor();
    if (await prof.getByText('Planner', { exact: true }).count()) throw new Error('planner shown to a plain professor');
    if (await prof.getByText('Cover a class', { exact: true }).count()) throw new Error('cover shown to a plain professor');
    await visible(prof, /^Code DEMO-2026$/, false).waitFor();
    await shot(prof, 'professor-more');
  });

  await step('The admin opens People & roles → the professor → grants “Planner & cover”', async () => {
    admin = (await demoSignIn(browser, 'Dr. N. Iyer')).page;
    await more(admin);
    await visible(admin, /Admin \(principal \/ HOD\): everything/, false).waitFor();
    await admin.getByText('People & roles', { exact: true }).click();
    await admin.getByRole('tab', { name: 'Professors' }).click();
    await admin.getByText('banerjee@demo.attendly.app').waitFor({ timeout: 20_000 });
    await admin.waitForTimeout(900); // a person's pace (the app ignores double taps)
    await admin.getByText('banerjee@demo.attendly.app').click();
    await visible(admin, 'Role & permissions').waitFor();
    await admin.getByRole('checkbox', { name: 'Planner & cover' }).click();
    await admin.getByRole('button', { name: 'Save role & permissions' }).click();
    await visible(admin, /sees the change on their next screen/, false).waitFor();
    await shot(admin, 'admin-grants');
  });

  await step('The professor now has the planner and the cover board', async () => {
    lastPage = prof;
    await prof.getByText('Today', { exact: true }).last().click();
    await more(prof);
    await visible(prof, /also allowed: Planner & cover/, false).waitFor({ timeout: 30_000 });
    await prof.waitForTimeout(900);
    await prof.getByText('Cover a class', { exact: true }).last().click();
    await visible(prof, 'Teachers').waitFor({ timeout: 20_000 });
    if (await prof.getByText('For admins only').count()) throw new Error('still refused');
    await shot(prof, 'professor-cover');
  });

  await step('The admin takes it back; the professor is refused again', async () => {
    lastPage = prof;
    await admin.getByRole('checkbox', { name: 'Planner & cover' }).click();
    await admin.getByRole('button', { name: 'Save role & permissions' }).click();
    await visible(admin, /sees the change on their next screen/, false).waitFor();
    await prof.getByRole('button', { name: 'Back' }).locator('visible=true').first().click();
    await prof.getByText('Today', { exact: true }).last().click();
    await more(prof);
    await visible(prof, /Professor: your classes, batches and reports/, false).waitFor({ timeout: 30_000 });
    if (await prof.getByText('Cover a class', { exact: true }).count()) throw new Error('cover still shown');
  });

  await browser.close();
  console.log(ERRORS.length ? `\n${ERRORS.length} problem(s):\n- ${ERRORS.join('\n- ')}` : '\nAll good.');
  process.exit(ERRORS.length ? 1 : 0);
})();
