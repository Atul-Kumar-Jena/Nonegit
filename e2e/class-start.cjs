/**
 * The two class logs (demo server): the class time starts → the professor is reminded and the batch
 * sees "Waiting for the professor"; the professor arrives and taps "I’m in class — start" → the batch
 * sees it live (with how late); the QR is opened only when the professor chooses.
 *   OUT=/tmp/shots-class NODE_PATH=... node e2e/class-start.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.env.OUT || '/tmp/shots-class';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const API = 'http://localhost:10000';
const TOKEN = fs.readFileSync('/tmp/e2ekeys', 'utf8').trim().split(' ')[2];
const HERE = { latitude: 28.545, longitude: 77.1926 };
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
const dev = async (path, body) =>
  (await fetch(API + path, { method: body ? 'POST' : 'GET', headers: { 'x-dev-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

async function demoSignIn(browser, url, name) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, geolocation: { ...HERE, accuracy: 8 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  lastPage = page;
  page.on('pageerror', (e) => ERRORS.push(`${name} page error: ${e.message}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(url);
  const demoInst = page.getByRole('button', { name: /Try the demo/ });
  await Promise.race([demoInst.waitFor({ timeout: 60_000 }), page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 })]).catch(() => {});
  if (await demoInst.isVisible().catch(() => false)) {
    await demoInst.click();
    await page.getByRole('button', { name: /^Continue to / }).click({ timeout: 20_000 });
  }
  await page.getByRole('button', { name: new RegExp(`Sign in as ${name}`) }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Bind this device' }).click({ timeout: 30_000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let t, s;

  await step('CS-301’s class time started 4 minutes ago; the professor hasn’t started it', async () => {
    const course = (await dev('/dev/api/courses')).find((c) => c.code === 'CS-301');
    const sess = await dev('/dev/api/sessions', { courseId: course.id, room: 'LH-2', lat: HERE.latitude, lng: HERE.longitude, radiusM: 150, rotationS: 7, durationMin: 60, status: 'scheduled', startedMinAgo: 4 });
    if (!sess.id) throw new Error(JSON.stringify(sess));
    await new Promise((r) => setTimeout(r, 21_000)); // one tick of the class clock: log 1
  });

  await step('Student: the class shows “Waiting for the professor”', async () => {
    s = await demoSignIn(browser, 'http://localhost:8081', 'Aarav Reddy');
    await s.getByText('Waiting for the professor').first().waitFor({ timeout: 30_000 });
    await shot(s, 'student-waiting');
  });

  await step('Professor: the class says “Waiting to start”, with the class-time log', async () => {
    t = await demoSignIn(browser, 'http://localhost:8082', 'Dr. N. Iyer');
    await t.getByText('Waiting to start').first().click({ timeout: 30_000 });
    await t.getByText('Class time', { exact: true }).waitFor({ timeout: 20_000 });
    await t.getByText(/Waiting · \d+ min since class time/).waitFor();
    await shot(t, 'prof-waiting');
  });

  await step('Professor arrives: “I’m in class — start” → live for the batch, marked late, QR not shown yet', async () => {
    await t.getByRole('button', { name: 'I’m in class — start' }).click();
    await t.getByText(/Class started — your students see it live/).locator('visible=true').first().waitFor({ timeout: 30_000 });
    await t.getByText(/min late/).locator('visible=true').first().waitFor();
    await t.getByText('Class is live — show the QR when you want to take attendance').locator('visible=true').first().waitFor();
    await shot(t, 'prof-live');
  });

  await step('Student: the class is live, “started N min late”', async () => {
    await s.getByText(/LIVE · started \d+ min late/).first().waitFor({ timeout: 45_000 });
    await shot(s, 'student-live');
  });

  await step('Professor chooses to show the QR → the student sees “Attendance being taken”', async () => {
    await t.getByRole('button', { name: 'Show the QR code' }).click();
    await s.getByText('Attendance being taken — scan now').first().waitFor({ timeout: 45_000 });
    await shot(s, 'student-taking');
  });

  await browser.close();
  console.log(`\nERRORS: ${JSON.stringify(ERRORS, null, 1)}`);
  process.exit(ERRORS.length ? 1 : 0);
})();
