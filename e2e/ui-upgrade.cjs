/**
 * Interface rehearsal (demo server, see README.md): Who's free, a room with a typed 20 m geofence,
 * a class typed into the planner ("2:30 pm") with the detailed preview before publishing, batch
 * mentors, the grouped notification list, and the student's privacy switches.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = process.env.OUT || '/tmp/shots-ui';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const INSTITUTE = 'http://localhost:8082';
const STUDENT = 'http://localhost:8081';
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
const pause = (p) => p.waitForTimeout(900);
const visible = (page, text, exact = true) => page.getByText(text, { exact }).locator('visible=true').first();

async function demoSignIn(browser, name, url = INSTITUTE) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1, geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 8 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  lastPage = page;
  page.on('pageerror', (e) => ERRORS.push(`${name} page error: ${e.message}`));
  page.on('console', (m) => {
    if (process.env.DEBUG_CONSOLE && m.type() === 'error') console.log('  [console]', m.text().slice(0, 600));
  });
  page.on('dialog', (d) => void d.accept());
  await page.goto(url);
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
async function openMore(p, tile) {
  await p.getByText('More', { exact: true }).last().click();
  await pause(p);
  await visible(p, tile).click();
  await pause(p);
}
const back = async (p) => {
  await p.getByRole('button', { name: 'Back' }).locator('visible=true').first().click();
  await pause(p);
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let a;

  await step('Admin: Who’s free shows who is free and until when', async () => {
    a = (await demoSignIn(browser, 'Dr. N. Iyer')).page;
    await openMore(a, 'Who’s free');
    await visible(a, 'Who’s free').waitFor();
    await visible(a, /free at /, false).waitFor({ timeout: 20_000 });
    await visible(a, /^(Free until|Free all day|Free for the rest|Teaching)/, false).waitFor();
    await a.getByLabel('Check time: type a time like 10:30').fill('11:00');
    await a.getByLabel('Check time: type a time like 10:30').press('Enter');
    await visible(a, /free at 11:00 AM/, false).waitFor();
    await shot(a, 'who-is-free');
    await back(a);
  });

  await step('Admin: a room with a typed 20 m geofence, centre averaged from GPS', async () => {
    await openMore(a, 'Rooms');
    await a.getByRole('button', { name: /^Add$/ }).first().click();
    await a.getByPlaceholder('LH-204').fill('Lab 20');
    await a.getByRole('button', { name: 'Use my location' }).click();
    await visible(a, /Centre saved · measured to ±8 m/, false).waitFor({ timeout: 30_000 });
    await a.getByLabel('Custom distance in metres').fill('20');
    await a.getByLabel('Custom distance in metres').press('Enter');
    await visible(a, /within 20 m of the classroom centre/, false).waitFor();
    await shot(a, 'room-20m');
    await a.getByRole('button', { name: 'Save room' }).click();
    await visible(a, /Location saved · ±8 m · 20 m radius/, false).waitFor({ timeout: 15_000 });
    await back(a);
  });

  await step('Admin: a class typed into the planner (“2:30 pm”), previewed in detail, then published', async () => {
    await openMore(a, 'Planner');
    const chip = a.getByRole('button', { name: /tap to add a class/ }).first();
    await chip.waitFor({ timeout: 30_000 });
    await pause(a);
    await chip.click();
    await visible(a, /^Add /, false).waitFor();
    await a.getByRole('button', { name: 'One day later' }).locator('visible=true').first().click();
    await a.getByLabel('Start: type a time like 10:30').fill('2:30 pm');
    await a.getByLabel('Start: type a time like 10:30').press('Enter');
    await shot(a, 'planner-add-typed');
    await a.getByRole('button', { name: 'Add to draft' }).click();
    await a.getByRole('button', { name: 'Review & publish' }).click();
    await visible(a, 'Preview before publishing').waitFor();
    await visible(a, '1 class changes').waitFor();
    await visible(a, 'New class').waitFor();
    await visible(a, /2:30 PM–3:30 PM/, false).waitFor();
    await visible(a, /students? will be notified/, false).waitFor();
    await shot(a, 'planner-preview');
    await a.getByRole('button', { name: /Publish (anyway )?& notify/ }).click();
    await visible(a, 'Published').waitFor({ timeout: 20_000 });
    await shot(a, 'planner-published');
    await a.getByRole('button', { name: 'Done' }).click();
    await pause(a);
    await a.getByRole('button', { name: 'Back' }).first().click();
    await pause(a);
  });

  await step('Admin: a Sunday class set by hand (subject, typed date & time, teacher), previewed and published', async () => {
    await openMore(a, 'Planner');
    await a.getByRole('button', { name: 'Add class' }).waitFor({ timeout: 30_000 });
    await visible(a, 'Sun').waitFor(); // Sunday is always on the board
    await pause(a);
    await a.getByRole('button', { name: 'Add class' }).click();
    await visible(a, 'Add a class').waitFor();
    await visible(a, 'Choose a subject').click();
    await pause(a);
    await visible(a, /^CS-301 · /, false).click();
    await pause(a);
    await a.getByRole('button', { name: /Tap to type a date/ }).locator('visible=true').first().click();
    await a.getByLabel('Date, for example 27/09/2026').fill('04/10/2026');
    await a.getByLabel('Date, for example 27/09/2026').press('Enter');
    await visible(a, /Sun, Oct 4, 2026/, false).waitFor();
    await a.getByLabel('Start: type a time like 10:30').fill('9:15 am');
    await a.getByLabel('Start: type a time like 10:30').press('Enter');
    await shot(a, 'manual-add-sunday');
    await a.getByRole('button', { name: 'Add to draft' }).click();
    await a.getByRole('button', { name: 'Review & publish' }).click();
    await visible(a, 'Preview before publishing').waitFor();
    await visible(a, /Sun 4\/10 9:15 AM/, false).waitFor();
    await shot(a, 'manual-preview');
    await a.getByRole('button', { name: /Publish (anyway )?& notify/ }).click();
    await visible(a, 'Published').waitFor({ timeout: 20_000 });
    await a.getByRole('button', { name: 'Done' }).click();
    await pause(a);
    await a.getByRole('button', { name: 'Back' }).first().click();
    await pause(a);
  });

  await step('Admin: CSE-6A shows its mentor', async () => {
    await openMore(a, 'Batches');
    await visible(a, 'CSE-6A').waitFor({ timeout: 20_000 });
    await visible(a, 'Mentor: Dr. S. Banerjee').waitFor();
    await visible(a, 'CSE-6A').click();
    await pause(a);
    await a.getByRole('tab', { name: 'Settings' }).click();
    await visible(a, 'Mentor').waitFor();
    await visible(a, 'Phone switch and unbind requests from this batch’s students go to the mentor.').waitFor();
    await shot(a, 'batch-mentor');
  });

  await step('Student: grouped notification list with filters; privacy switches in Profile', async () => {
    const s = (await demoSignIn(browser, 'Aarav Reddy', STUDENT)).page;
    await s.getByText('Profile', { exact: true }).last().click();
    await pause(s);
    await visible(s, 'Lock Attendly').waitFor();
    await visible(s, 'Confirm each scan').waitFor();
    if (await s.getByText(/HWID|ed25519|Pinned key/).count()) throw new Error('technical details still shown');
    await shot(s, 'student-profile');
    await visible(s, 'Notifications').click();
    await pause(s);
    await visible(s, 'Today').waitFor({ timeout: 20_000 });
    await s.getByRole('tab', { name: 'All' }).waitFor();
    await shot(s, 'student-notifications');
  });

  await browser.close();
  console.log(ERRORS.length ? `\n${ERRORS.length} problem(s):\n- ${ERRORS.join('\n- ')}` : '\nAll good.');
  process.exit(ERRORS.length ? 1 : 0);
})();
