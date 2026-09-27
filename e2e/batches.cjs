/**
 * Batch-first hierarchy rehearsal (demo server, see README.md): a professor creates a batch with its
 * semester, adds registered students, pastes a class list, creates a subject, moves the batch up a
 * semester; another professor can add but not change it.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = process.env.OUT || '/tmp/shots-batches';
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
  let p;
  await step('Classes opens on batches, grouped by semester', async () => {
    p = (await demoSignIn(browser, 'Dr. S. Banerjee')).page;
    await p.getByText('Classes', { exact: true }).last().click();
    await visible(p, 'Semester 6').waitFor();
    await visible(p, 'CSE-6A').waitFor();
    await shot(p, 'classes-batches');
  });

  await step('A professor creates a batch with its department and semester', async () => {
    await p.getByRole('button', { name: 'New batch' }).click();
    await p.getByPlaceholder('CSE-5A').fill('MATH-3A');
    await p.getByPlaceholder('CSE', { exact: true }).fill('Maths');
    await p.getByRole('radio', { name: '3', exact: true }).click();
    await p.getByRole('button', { name: 'Create batch' }).click();
    await visible(p, 'Batch created. Next: add its students, then its subjects.').waitFor();
    await visible(p, 'Maths · Semester 3').waitFor();
    await shot(p, 'batch-created');
  });

  await step('Adds a registered student by search', async () => {
    await p.getByRole('button', { name: 'Add students' }).click();
    await p.getByPlaceholder('Search name or roll no.').locator('visible=true').last().fill('Aarav');
    await p.getByRole('checkbox', { name: /Aarav Reddy/ }).click();
    await p.getByRole('button', { name: 'Add 1 to MATH-3A' }).click();
    await visible(p, /1 added/, false).waitFor();
    await visible(p, 'Aarav Reddy').waitFor();
  });

  await step('Pastes a class list: one new student, one already registered', async () => {
    await p.getByRole('button', { name: 'Paste a list' }).click();
    await p.getByLabel('Pasted list').fill('Neha Gupta, 23MA001, neha@demo.attendly.app\nPriya Sharma, 21CS1109, priya@demo.attendly.app');
    await p.getByRole('button', { name: /^Add 2 students/ }).click();
    await visible(p, '1 new').waitFor();
    await visible(p, '1 already registered — added').waitFor();
    await shot(p, 'pasted');
    await p.getByRole('button', { name: 'Back' }).locator('visible=true').first().click();
    await visible(p, 'Neha Gupta').waitFor();
    await visible(p, 'Priya Sharma').waitFor();
  });

  await step('Creates a new subject inside the batch (they teach it)', async () => {
    await p.getByRole('tab', { name: /Subjects/ }).click();
    await p.getByRole('button', { name: 'Add a subject' }).click();
    await p.getByRole('tab', { name: 'New subject' }).click();
    await p.getByPlaceholder('CS-501').fill('MA-301');
    await p.getByPlaceholder('Compiler Design').fill('Probability');
    await visible(p, 'You will teach this subject').waitFor();
    await p.getByRole('button', { name: 'Create subject' }).click();
    await visible(p, /MA-301 created in MATH-3A/, false).waitFor();
    await visible(p, /Ask an admin to add its weekly slots/, false).waitFor();
    await visible(p, 'MA-301 · Probability').waitFor();
    await shot(p, 'subject-created');
  });

  await step('Moves the batch up to the next semester', async () => {
    await p.getByRole('tab', { name: 'Settings' }).click();
    await p.getByRole('button', { name: 'Move up to Semester 4' }).click();
    await visible(p, 'MATH-3A moved up to Semester 4.').waitFor();
    await visible(p, 'Maths · Semester 4').waitFor();
  });

  await step('Another professor can add, but not remove or change', async () => {
    const k = (await demoSignIn(browser, 'Dr. R. Khanna')).page;
    await k.getByText('Classes', { exact: true }).last().click();
    await visible(k, 'Semester 4').waitFor();
    await visible(k, 'MATH-3A').click();
    await visible(k, 'Neha Gupta').waitFor();
    if (await k.getByRole('button', { name: /^Remove / }).count()) throw new Error('remove buttons shown to a non-owner');
    await k.getByRole('tab', { name: 'Settings' }).click();
    await visible(k, /Renaming, changing the semester, removing or archiving is for an admin/, false).waitFor();
    await shot(k, 'other-professor');
  });

  await browser.close();
  console.log(ERRORS.length ? `\n${ERRORS.length} problem(s):\n- ${ERRORS.join('\n- ')}` : '\nAll good.');
  process.exit(ERRORS.length ? 1 : 0);
})();
