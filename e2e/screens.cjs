/**
 * Screenshots of every screen of Attendly Institute and Attendly (student) at phone size, top and
 * scrolled to the bottom, for a spacing / layout review (demo server).
 *   OUT=/tmp/shots-screens NODE_PATH=... node e2e/screens.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.env.OUT || '/tmp/shots-screens';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const API = 'http://localhost:10000';
const TOKEN = fs.readFileSync('/tmp/e2ekeys', 'utf8').trim().split(' ')[2];
const HERE = { latitude: 28.545, longitude: 77.1926 };
const dev = async (path, body) =>
  (await fetch(API + path, { method: body ? 'POST' : 'GET', headers: { 'x-dev-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

async function demoSignIn(browser, url, name) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, geolocation: { ...HERE, accuracy: 8 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(url);
  const demoInst = page.getByRole('button', { name: /Try the demo/ });
  await Promise.race([demoInst.waitFor({ timeout: 60_000 }), page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 })]).catch(() => {});
  if (await demoInst.isVisible().catch(() => false)) {
    await demoInst.click();
    await page.getByRole('button', { name: /^Continue to / }).click({ timeout: 20_000 });
  }
  await page.getByRole('button', { name: new RegExp(`Sign in as ${name}`) }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Bind this device' }).click({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  return page;
}

/** Client-side navigation (a reload would sign the web build out). */
async function go(page, path) {
  await page.evaluate((p) => window.__router.push(p), path);
  await page.waitForTimeout(2200);
}

async function capture(page, app, name) {
  const base = `${OUT}/${app}-${name.replace(/[^a-z0-9]+/gi, '_')}`;
  await page.screenshot({ path: `${base}-1.png` });
  // Scroll the page's main scroller to the bottom for the second shot.
  const scrolled = await page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('div')) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40 && el.offsetParent !== null) {
        if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
      }
    }
    if (!best) return false;
    best.scrollTop = best.scrollHeight;
    return true;
  });
  if (scrolled) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${base}-2.png` });
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const course = (await dev('/dev/api/courses')).find((c) => c.code === 'CS-301');
  const live = await dev('/dev/api/sessions', { courseId: course.id, room: 'LH-2', lat: HERE.latitude, lng: HERE.longitude, radiusM: 50, rotationS: 7, durationMin: 60 });

  const t = await demoSignIn(browser, 'http://localhost:8082', 'Dr. N. Iyer');
  const inst = ['/home', '/timetable', '/classes', '/more', '/batches', '/busy', '/course-form', `/course/${course.id}`, '/cover', '/extra-class', '/flags', '/import', '/inbox', '/institution', '/notice-compose', '/notices', '/notifications', '/people', '/permissions', '/person-form?role=teacher', '/planner', '/reminders', '/reports', '/requests', '/rooms', '/professors', '/reports?view=trends', '/roster', '/security', '/setup', '/slot-form', `/session/${live.id}`, `/register/${live.id}`, '/attend'];
  for (const p of inst) {
    try {
      await go(t, p);
      await capture(t, 'inst', p);
      process.stdout.write('.');
    } catch (e) {
      console.log(`\ninst ${p}: ${e.message.split('\n')[0]}`);
    }
  }
  const s = await demoSignIn(browser, 'http://localhost:8081', 'Aarav Reddy');
  const stud = ['/home', '/timetable', '/subjects', '/profile', '/notices', '/notifications', '/permissions', '/reminders', '/report', '/requests', '/security', `/subject/${course.id}`, '/scan'];
  for (const p of stud) {
    try {
      await go(s, p);
      await capture(s, 'stud', p);
      process.stdout.write('.');
    } catch (e) {
      console.log(`\nstud ${p}: ${e.message.split('\n')[0]}`);
    }
  }
  await browser.close();
  console.log(`\n${fs.readdirSync(OUT).length} screenshots in ${OUT}`);
})();
