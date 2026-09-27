/**
 * Notice centre rehearsal (demo server, see README.md): a student reads a formatted pinned notice
 * and reacts; a professor writes one with the toolbar, previews it and sends it to a batch; the
 * student gets it; the professor sees "seen by"; only the admin may address everyone.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = process.env.OUT || '/tmp/shots-notices';
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

async function demoSignIn(browser, name, url = INSTITUTE) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  lastPage = page;
  page.on('pageerror', (e) => ERRORS.push(`${name} page error: ${e.message}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(url);
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
  await page.getByText(url === INSTITUTE ? 'Classes' : 'Profile', { exact: true }).last().waitFor({ timeout: 30_000 });
  return { ctx, page };
}
const visible = (page, text, exact = true) => page.getByText(text, { exact }).locator('visible=true').first();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let s, p;
  const STUDENT = 'http://localhost:8081';

  await step('Student: Home shows new notices; the pinned welcome is formatted', async () => {
    const r = await demoSignIn(browser, 'Aarav Reddy', STUDENT);
    s = r.page;
    await visible(s, /Notices · \d+ new/, false).waitFor({ timeout: 30_000 });
    await visible(s, 'MA-202 quiz on Friday').waitFor();
    await s.waitForTimeout(900);
    await visible(s, /Notices · \d+ new/, false).click();
    await visible(s, 'Notice centre').waitFor();
    await visible(s, 'Pinned').waitFor();
    await shot(s, 'student-centre');
    await s.waitForTimeout(900);
    await visible(s, 'Welcome to the Spring Term').click();
    await visible(s, 'Welcome back!').waitFor(); // "# Welcome back!" rendered as a heading, no "#"
    await visible(s, 'Please remember').waitFor();
    if (await s.getByText('# Welcome back!').count()) throw new Error('markdown shown raw');
    await shot(s, 'student-detail');
  });

  await step('Student reacts 👍 and 🎉, then takes 👍 back', async () => {
    await s.getByRole('button', { name: 'Add a reaction' }).click();
    await s.getByRole('button', { name: 'React 👍' }).click();
    await visible(s, /^1$/, false).waitFor();
    await s.getByRole('button', { name: 'Add a reaction' }).click();
    await s.getByRole('button', { name: 'React 🎉' }).click();
    await s.getByRole('button', { name: '👍 1, yours' }).click();
    await s.getByRole('button', { name: '🎉 1, yours' }).waitFor();
    if (await s.getByRole('button', { name: /^👍/ }).count()) throw new Error('👍 still there');
    await shot(s, 'student-reacted');
  });

  await step('Professor: can’t address everyone; writes a formatted notice to CSE-6A, previews, sends', async () => {
    p = (await demoSignIn(browser, 'Dr. S. Banerjee')).page;
    await p.getByText('More', { exact: true }).last().click();
    await p.waitForTimeout(900);
    await p.getByText('Notice centre', { exact: true }).last().click();
    await p.getByRole('button', { name: 'New notice' }).waitFor();
    await p.waitForTimeout(900);
    await p.getByRole('button', { name: 'New notice' }).click();
    await visible(p, 'Send to').waitFor();
    if (await p.getByRole('radio', { name: 'Everyone' }).count()) throw new Error('Everyone offered to a professor');
    await p.getByRole('checkbox', { name: /CSE-6A/ }).click();
    await visible(p, /Reaches 8 people · CSE-6A/, false).waitFor({ timeout: 15_000 });
    await p.getByRole('radio', { name: '📝 Exam' }).click();
    await p.getByLabel('Title').fill('Lab record check');
    await p.getByLabel('Notice text').fill('Bring your lab record on Monday.\n');
    await p.getByRole('button', { name: 'Bullet list' }).click(); // "- " on the current line
    await p.getByLabel('Notice text').press('End');
    await p.getByLabel('Notice text').type('Signed by your lab partner');
    await p.getByRole('button', { name: 'Bold' }).click(); // inserts **bold**
    await p.getByRole('tab', { name: 'Preview' }).click();
    await visible(p, 'Lab record check').waitFor();
    await visible(p, '•').waitFor();
    await shot(p, 'professor-preview');
    await p.getByRole('button', { name: /^Send to 8 people/ }).click();
    await visible(p, /Seen by 0 of 8/, false).waitFor({ timeout: 20_000 });
    await visible(p, 'To CSE-6A').waitFor();
    await shot(p, 'professor-sent');
  });

  await step('The student gets it in the bell and the Notice centre; the professor sees “Seen by 1 of 8”', async () => {
    await s.getByRole('button', { name: 'Back' }).locator('visible=true').first().click();
    await s.waitForTimeout(900);
    await s.getByText('Home', { exact: true }).last().click().catch(() => {});
    await visible(s, 'Lab record check').waitFor({ timeout: 40_000 });
    await s.waitForTimeout(900);
    await visible(s, 'Lab record check').click();
    await visible(s, 'Bring your lab record on Monday.').waitFor();
    // Reopen it (pull-to-refresh on a phone).
    await p.getByRole('button', { name: 'Back' }).locator('visible=true').first().click();
    await p.waitForTimeout(900);
    await visible(p, 'Lab record check').click();
    await visible(p, /Seen by 1 of 8/, false).waitFor({ timeout: 40_000 });
    await shot(p, 'professor-seen');
  });

  await step('The admin can address everyone', async () => {
    const a = (await demoSignIn(browser, 'Dr. N. Iyer')).page;
    await a.getByText('More', { exact: true }).last().click();
    await a.waitForTimeout(900);
    await a.getByText('Notice centre', { exact: true }).last().click();
    await a.getByRole('button', { name: 'New notice' }).waitFor();
    await a.waitForTimeout(900);
    await a.getByRole('button', { name: 'New notice' }).click();
    await a.getByRole('radio', { name: 'Everyone' }).click();
    await visible(a, /Reaches \d+ people · Everyone/, false).waitFor({ timeout: 15_000 });
    await shot(a, 'admin-everyone');
  });

  await browser.close();
  console.log(ERRORS.length ? `\n${ERRORS.length} problem(s):\n- ${ERRORS.join('\n- ')}` : '\nAll good.');
  process.exit(ERRORS.length ? 1 : 0);
})();
