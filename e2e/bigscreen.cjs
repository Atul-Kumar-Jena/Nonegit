/**
 * Big-screen rehearsal (demo server, see README.md): a classroom PC opens /tv, its pairing QR is
 * read from the screen's pixels, the teacher pairs + approves from the Institute app, the PC shows
 * the rotating class QR, a student scans it *from the PC's pixels* and is marked present, the PC's
 * count goes up, and ending the class blanks the PC.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const jsQR = require(__dirname + '/node_modules/jsqr');
const { PNG } = require(__dirname + '/node_modules/pngjs');

const OUT = process.env.OUT || '/tmp/shots-bigscreen';
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
    const extra = await fn();
    console.log(extra ? `ok (${extra})` : 'ok');
  } catch (err) {
    console.log('FAILED');
    if (lastPage) await lastPage.screenshot({ path: `${OUT}/FAILED-${String(++n).padStart(2, '0')}.png` }).catch(() => {});
    ERRORS.push(`${name}: ${err.message.split('\n')[0]}`);
  }
};
const dev = async (path, body) =>
  (await fetch(API + path, { method: body ? 'POST' : 'GET', headers: { 'x-dev-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const readQr = async (locator) => {
  const png = PNG.sync.read(await locator.screenshot());
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!r) throw new Error('QR not readable from the screen');
  return r.data;
};

async function demoSignIn(browser, url, name) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, geolocation: { ...HERE, accuracy: 8 }, permissions: ['geolocation', 'camera'] });
  // The phone camera: the browser's barcode detector returns whatever QR text the test decoded from the PC's pixels.
  await ctx.addInitScript(() => {
    window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code']; } async detect() { return window.__qr ? [{ rawValue: window.__qr, format: 'qr_code', boundingBox: { x: 0, y: 0, width: 9, height: 9 }, cornerPoints: [] }] : []; } };
  });
  const page = await ctx.newPage();
  lastPage = page;
  page.on('pageerror', (e) => ERRORS.push(`${name} page error: ${e.message}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(url);
  const demoInst = page.getByRole('button', { name: /Try the demo/ });
  await Promise.race([demoInst.waitFor({ timeout: 60_000 }), page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 })]).catch(() => {});
  if (await demoInst.isVisible().catch(() => false)) {
    await demoInst.click();
    await page.getByText('Verified by Attendly').waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Continue to / }).click();
  }
  await page.getByRole('button', { name: new RegExp(`Sign in as ${name}`) }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Bind this device' }).click({ timeout: 30_000 });
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  let session, t, board, code;

  await step('A CS-301 class goes live', async () => {
    const course = (await dev('/dev/api/courses')).find((c) => c.code === 'CS-301');
    session = await dev('/dev/api/sessions', { courseId: course.id, room: 'LH-2', lat: HERE.latitude, lng: HERE.longitude, radiusM: 150, rotationS: 7, durationMin: 60 });
    if (!session.id) throw new Error(JSON.stringify(session));
  });

  await step('Classroom PC opens /tv: a code and a pairing QR that decodes to it', async () => {
    board = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    board.on('pageerror', (e) => ERRORS.push('board page error: ' + e.message));
    await board.goto(`${API}/tv`);
    await board.locator('#code').filter({ hasText: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/ }).waitFor({ timeout: 15_000 });
    code = (await board.locator('#code').textContent()).trim();
    await board.locator('#pairqr svg').waitFor();
    await shot(board, 'pc-pairing');
    const scanned = await readQr(board.locator('#pairqr'));
    if (scanned !== `ATTENDLY-TV:${code.replace('-', '')}`) throw new Error(`pairing QR says ${scanned}, screen shows ${code}`);
    return `${code} ↔ ${scanned}`;
  });

  await step('Teacher opens the live class → Big screen → enters the code → sees “Chrome on Linux” → approves', async () => {
    t = (await demoSignIn(browser, 'http://localhost:8082', 'Dr. N. Iyer')).page;
    await t.getByText(/CS-301/).locator('visible=true').first().click({ timeout: 30_000 });
    await t.getByRole('button', { name: /Show on a big screen/ }).click({ timeout: 30_000 });
    await t.getByRole('button', { name: 'Scan the screen' }).waitFor();
    await t.getByLabel('Screen code').fill(code.toLowerCase());
    await t.getByRole('button', { name: 'Find', exact: true }).click();
    await t.getByText(/Chrome on Linux/).first().waitFor({ timeout: 15_000 });
    await shot(t, 'teacher-approve');
    await t.getByRole('button', { name: /Approve & show QR/ }).click();
    await t.getByText(/now shows the CS-301 QR/).waitFor({ timeout: 15_000 });
  });

  let token;
  await step('The PC shows the rotating class QR, full-size, with the count', async () => {
    await board.locator('#qr svg').waitFor({ timeout: 15_000 });
    await board.getByText(/present/).first().waitFor();
    await shot(board, 'pc-live');
    token = await readQr(board.locator('#qr'));
    return `decoded ${token.length} chars from pixels`;
  });

  await step('A student scans the PC’s QR → marked present, and the PC’s count goes up', async () => {
    const s = (await demoSignIn(browser, 'http://localhost:8081', 'Aarav Reddy')).page;
    await s.getByRole('button', { name: /Scan for/ }).first().click({ timeout: 60_000 });
    token = await readQr(board.locator('#qr')); // the freshest code
    await s.evaluate((v) => { window.__qr = v; }, token);
    await s.getByText('Marked present').waitFor({ timeout: 20_000 });
    await shot(s, 'student-marked');
    await board.locator('#count').filter({ hasText: /^1\b/ }).waitFor({ timeout: 15_000 });
    await shot(board, 'pc-count');
  });

  await step('Ending the class blanks the PC', async () => {
    await dev(`/dev/api/sessions/${session.id}/end`, {});
    await board.getByText('Class ended').waitFor({ timeout: 15_000 });
    await shot(board, 'pc-ended');
  });

  await browser.close();
  console.log(ERRORS.length ? `\n${ERRORS.length} problem(s):\n- ${ERRORS.join('\n- ')}` : '\nAll good.');
  process.exit(ERRORS.length ? 1 : 0);
})();
