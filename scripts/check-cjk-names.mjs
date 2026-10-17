#!/usr/bin/env node
// End-to-end check that Chinese guest names survive the whole path and render on the wall:
// POST /allocate → data/state.json → GET /state → dist/index.html → glyph grid (check-in list + banner).
// Runs a throwaway copy of the wall in a temp dir, so the real data/state.json is never touched.
//   node scripts/check-cjk-names.mjs [--screenshot out.png]
// Needs playwright-core (npm install) and a local Chrome (or LUMA_CHROME_PATH).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = ['张寒冰', '乔枫', '鲁周毅'];
const LIVE = '王小明';   // allocated after the page is open, so it also goes through the celebration banner
const shotArg = process.argv.indexOf('--screenshot');
const SHOT = shotArg > 0 ? path.resolve(process.argv[shotArg + 1]) : '';

const failures = [];
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures.push(msg); };

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const chrome = () => process.env.LUMA_CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));

// raw request so the body can be split in the middle of a multi-byte UTF-8 character
function post(port, p, obj, { split = false } = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({ port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': buf.length } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (!split) return req.end(buf);
    const cut = buf.indexOf(Buffer.from(obj.name, 'utf8')) + 1;   // 1 byte into the first 3-byte CJK character
    req.write(buf.subarray(0, cut)); setTimeout(() => req.end(buf.subarray(cut)), 50);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-cjk-'));
let server, browser;
try {
  for (const f of ['serve.mjs', 'build.mjs', 'package.json', 'data/codes.example.json']) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f)); }
  fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
  execFileSync(process.execPath, ['build.mjs'], { cwd: tmp, stdio: 'ignore' });

  const port = await freePort();
  const env = { ...process.env, PORT: String(port), LUMA_API_KEY: '', WALL_TOKEN: '', RESEND_API_KEY: '', EMAIL_OFF: '1', PUBLIC_URL: '' };
  server = spawn(process.execPath, ['serve.mjs'], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} if (i > 50) throw new Error('wall did not start'); await new Promise(r => setTimeout(r, 100)); }

  console.log('server / data path');
  const now = Date.now();
  for (const [i, name] of NAMES.entries()) {
    const r = await post(port, '/allocate', { key: `cjk${i}@example.com`, name, email: '', checkedInAt: new Date(now - (NAMES.length - i) * 60e3).toISOString(), source: 'luma' }, { split: i === 0 });
    check(JSON.parse(r.body).allocation?.name === name, `POST /allocate echoes ${name}${i === 0 ? ' (body split mid-character)' : ''}`);
  }
  const st = await fetch(base + '/state');
  check(/charset=utf-8/i.test(st.headers.get('content-type') || ''), `GET /state content-type: ${st.headers.get('content-type')}`);
  const names = (await st.json()).allocations.map(a => a.name);
  check(NAMES.every(n => names.includes(n)), `GET /state names: ${names.join(', ')}`);
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'data/state.json'), 'utf8')).allocations.map(a => a.name);
  check(NAMES.every(n => disk.includes(n)), `data/state.json names: ${disk.join(', ')}`);
  const page0 = await fetch(base + '/?manual');
  const html = await page0.text();
  check(/charset=utf-8/i.test(page0.headers.get('content-type') || '') && html.includes('<meta charset="utf-8">'), `GET / content-type: ${page0.headers.get('content-type')} + <meta charset="utf-8">`);

  console.log('rendered wall');
  const exe = chrome(); if (!exe) throw new Error('Chrome not found (set LUMA_CHROME_PATH)');
  browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/?manual&noblink', { waitUntil: 'load' });
  await page.waitForFunction(n => typeof app !== 'undefined' && app.feed.length >= n, NAMES.length, { timeout: 15000 });
  await post(port, '/allocate', { key: 'cjk-live@example.com', name: LIVE, email: '', checkedInAt: new Date().toISOString(), source: 'luma' });
  await page.waitForFunction(n => celeb.active && celeb.active.name === n && nowS() - celeb.t0 > 1.2, LIVE, { timeout: 15000 });

  // read the glyph grid back into text: static glyphs via GLYPHS, dynamic ones via the DYN atlas map
  const grid = await page.evaluate(() => {
    const L = layout(), hi = typeof glyphHi !== 'undefined' ? glyphHi : null;
    const back = new Map([...GLYPHS].map((c, i) => [i, c]));
    if (typeof DYN !== 'undefined') for (const [c, d] of DYN) { back.set(d.i, c); if (d.n > 1) back.set(d.i + 1, ''); }
    const rowText = (r, c0, c1) => { let s = ''; for (let c = c0; c < c1; c++) { const k = (G.rows - 1 - r) * G.cols + c; s += back.get(glyphBuf[k] + (hi ? hi[k] * 256 : 0)) ?? '?'; } return s; };
    const feed = []; for (let i = 0; i < Math.min(L.feedMax, app.feed.length); i++) feed.push(rowText(L.feedR + 2 + i, L.feedC + 8, L.feedC + L.FW - 2).trimEnd());
    const banner = []; for (let r = L.bannerR + 1; r < L.bannerR + L.bannerH; r++) banner.push(rowText(r, 0, G.cols));
    // every dynamic glyph tile must actually contain ink (i.e. a CJK-capable font was found)
    const cv = atlasTex.image, x = cv.getContext('2d'), tw = cv.width / (typeof AT !== 'undefined' ? AT : 16), th = cv.height / (typeof AT !== 'undefined' ? AT : 16);
    const blank = []; if (typeof DYN !== 'undefined') for (const [c, d] of DYN) { const per = typeof AT !== 'undefined' ? AT : 16; const px = x.getImageData((d.i % per) * tw, Math.floor(d.i / per) * th, tw * d.n, th).data; let ink = 0; for (let i = 0; i < px.length; i += 4) ink += px[i]; if (ink < 255 * 8) blank.push(c); }
    return { feed, banner, blank };
  });
  for (const n of [LIVE, ...NAMES]) check(grid.feed.some(r => r.includes(n)), `check-in list shows ${n}`);
  check(!grid.feed.some(r => r.includes('?')), `check-in list has no '?': ${JSON.stringify(grid.feed)}`);
  check(grid.banner.some(r => r.includes(LIVE)), `celebration banner shows ${LIVE}`);
  check(!grid.blank.length, `CJK atlas tiles have ink${grid.blank.length ? ' — blank: ' + grid.blank.join('') : ''}`);
  check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  if (SHOT) { await page.screenshot({ path: SHOT }); console.log(`  screenshot ${SHOT}`); }
} catch (e) {
  failures.push(String(e.message || e)); console.log(`  ✗ ${e.message || e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures.length ? `\nFAIL (${failures.length})` : '\nPASS');
process.exit(failures.length ? 1 : 0);
