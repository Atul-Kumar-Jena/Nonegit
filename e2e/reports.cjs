/**
 * Attendance reports rehearsal (demo server, see README.md): a teacher opens any batch and any
 * student, and downloads Excel / PDF; a student downloads their own report.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const { unzipSync, strFromU8 } = require('fflate');

const OUT = process.env.OUT || '/tmp/shots-reports';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const INSTITUTE = 'http://localhost:8082';
const STUDENT = 'http://localhost:8081';
const ERRORS = [];
let n = 0;
let lastPage = null;
const shot = async (page, name) => (lastPage = page).screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: false });
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

async function demoSignIn(browser, url, name) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  lastPage = page;
  page.on('pageerror', (e) => ERRORS.push(`${name} page error: ${e.message}`));
  await page.goto(url);
  await page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: new RegExp(`Sign in as ${name}`) }).click();
  const bind = page.getByRole('button', { name: 'Bind this device' });
  await bind.waitFor({ timeout: 30_000 });
  await bind.click();
  return { ctx, page };
}

/** Clicks a download button and checks the .xlsx: a real workbook that ends with the credit. */
async function excel(page, button, expect) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), button.click()]);
  const file = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(file);
  const z = unzipSync(fs.readFileSync(file));
  const sheet = strFromU8(z['xl/worksheets/sheet1.xml']);
  if (!sheet.slice(sheet.lastIndexOf('<row')).includes('Attendly · Created by Atul Kumar Jena')) throw new Error('credit line missing at the end');
  for (const t of expect) if (!sheet.includes(t)) throw new Error(`"${t}" missing from ${dl.suggestedFilename()}`);
  return dl.suggestedFilename();
}

/** PDF on the web goes through the print dialog; catch the HTML it prints. */
async function pdf(page, button, expect) {
  await page.evaluate(() => {
    window.__printed = null;
    const orig = HTMLIFrameElement.prototype;
    const obs = new MutationObserver(() => {
      for (const f of document.querySelectorAll('iframe')) {
        try {
          f.contentWindow.print = () => (window.__printed = f.contentWindow.document.documentElement.outerHTML);
        } catch {}
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    void orig;
  });
  await button.click();
  await page.waitForFunction(() => window.__printed, null, { timeout: 15_000 });
  const html = await page.evaluate(() => window.__printed);
  if (!html.includes('Created by Atul Kumar Jena')) throw new Error('credit missing from PDF');
  for (const t of expect) if (!html.includes(t)) throw new Error(`"${t}" missing from PDF`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let t;
  await step('A teacher (not an admin) opens Attendance reports from More', async () => {
    t = await demoSignIn(browser, INSTITUTE, 'Dr. S. Banerjee');
    await t.page.getByText('More', { exact: true }).last().click();
    await t.page.getByText('Attendance reports', { exact: true }).click();
    await t.page.getByText('1 · Batch').waitFor();
    await t.page.getByText(/average · \d+ students/).waitFor({ timeout: 20_000 });
    await shot(t.page, 'reports-all');
  });

  await step('Picks a batch, sees its students, downloads Excel (all subjects)', async () => {
    const chips = t.page.getByRole('radio');
    await chips.nth(1).click(); // first batch
    await t.page.waitForTimeout(800);
    await t.page.getByText(/average · \d+ students/).waitFor();
    await shot(t.page, 'reports-batch');
    const name = await excel(t.page, t.page.getByRole('button', { name: 'Excel' }).first(), ['Overall %']);
    console.log(`(${name}) `);
  });

  await step('Picks one subject, downloads the PDF', async () => {
    await t.page.getByRole('radio', { name: 'CS-301', exact: true }).click();
    await t.page.waitForTimeout(800);
    await pdf(t.page, t.page.getByRole('button', { name: 'PDF' }).first(), ['— attendance', 'Attended']);
    await shot(t.page, 'reports-subject');
  });

  await step('Opens a student: per-subject %, expands a subject to every class, downloads it', async () => {
    await t.page.getByRole('button', { name: /percent\. Open$/ }).first().click();
    await t.page.getByText('Per subject — tap for every class').waitFor();
    await t.page.getByRole('button', { name: /percent$/ }).first().click();
    await t.page.getByText(/Present|Absent/).first().waitFor({ timeout: 15_000 });
    await shot(t.page, 'student-expanded');
    await excel(t.page, t.page.getByRole('button', { name: /as Excel$/ }).first(), ['Class by class']);
  });

  let s;
  await step('A student downloads their own report (all subjects + one subject)', async () => {
    s = await demoSignIn(browser, STUDENT, 'Aarav Reddy');
    await s.page.getByText('Profile', { exact: true }).last().click();
    await s.page.getByText('Download attendance', { exact: true }).click();
    await s.page.getByText('All subjects (cumulative)').waitFor();
    await shot(s.page, 'student-download');
    await excel(s.page, s.page.getByRole('button', { name: 'Excel' }).first(), ['Cumulative', 'Aarav Reddy']);
    await excel(s.page, s.page.getByRole('button', { name: /as Excel$/ }).first(), ['Class by class']);
  });

  await step('Offline: the student can still download (from the copy on the phone)', async () => {
    await s.ctx.setOffline(true);
    await excel(s.page, s.page.getByRole('button', { name: 'Excel' }).first(), ['Cumulative']);
    await s.page.getByText(/No connection — this file uses the copy saved on this phone/).waitFor();
    await shot(s.page, 'student-offline');
    await s.ctx.setOffline(false);
  });

  await browser.close();
  console.log(ERRORS.length ? `\n${ERRORS.length} problem(s):\n- ${ERRORS.join('\n- ')}` : '\nAll good.');
  process.exit(ERRORS.length ? 1 : 0);
})();
