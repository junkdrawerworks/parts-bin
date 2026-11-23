// Uses Parts Bin in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// A pretend NFC reader stands in for the phone, and test/fake-google.mjs for Google Drive.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection, for the offline copy's checks at the end: 'up', 'down' (the server drops every
// connection) or 'stalled' (a garage with one bar, a captive wifi: it takes each request and holds on to it). With
// `release` set it serves the next release.
let net = 'up', release = false;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  serve(req, res);
}).listen(0);
// driveAt: a server whose sync.js lets the stand-in Drive be used from its address, for a device with an offline copy
// (routes can't reach what a service worker fetches).
async function serve(req, res, driveAt = '') {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (driveAt && path === '/js/sync.js') body = Buffer.from(String(body).replace("['https://parts-bin.junkdrawer.works', 'https://junkdrawer.works']", `['https://parts-bin.junkdrawer.works', '${driveAt}']`));
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const origin = `http://localhost:${server.address().port}`, base = origin + '/';

// A small inventory in the Stockroom artifact's export shape.
const tmp = await mkdtemp(join(tmpdir(), 'pb-'));
const exportFile = join(tmp, 'stockroom.json');
await writeFile(exportFile, JSON.stringify({
  bins: [{ id: 'bin-env', code: 'ENV', name: 'Environmental', location: 'Workroom', updatedAt: '2026-09-30T13:30:00Z' }],
  parts: [
    { id: 'p-bme280', name: 'BME280 (Adafruit)', binId: 'bin-env', category: 'Sensors', qty: 5, unit: 'pcs', tags: [], updatedAt: '2026-09-30T13:30:00Z' },
    { id: 'p-scd41', name: 'SCD41', binId: 'bin-env', category: 'Sensors', qty: 3, unit: 'pcs', tags: ['generic'], updatedAt: '2026-09-30T13:30:00Z' },
  ],
  projects: [{ id: 'proj-x', name: 'Test BOM', text: '2 BME280\n1 SCD41\n1 SGP30', updatedAt: '2026-09-30T13:30:00Z' }],
}));

const fakeNfc = () => {
  window.__written = []; let pending = null;
  window.__tap = () => { const p = pending; pending = null; if (!p) return false; window.__written.push(p.msg.records[0].data); p.resolve(); return true; };
  // the sticker refuses the write, as a real one does: NotAllowedError (it already holds something), NetworkError (taken away too soon)
  window.__fail = (name, msg) => { const p = pending; pending = null; if (!p) return false; p.reject(new DOMException(msg || name, name)); return true; };
  window.__waiting = () => !!pending;
  window.NDEFReader = class {
    async write(msg, o = {}) { return new Promise((resolve, reject) => { const p = pending = { msg, resolve, reject }; o.signal?.addEventListener('abort', () => { if (pending === p) pending = null; reject(new DOMException('stopped', 'AbortError')); }); }); } // a write that's stopped isn't made
    async scan() { window.__reader = this; }
  };
  window.__read = url => window.__reader?.onreading?.({ message: { records: [{ recordType: 'url', data: new TextEncoder().encode(url) }] } });
  navigator.permissions.query = async () => ({ state: 'granted' });
  navigator.vibrate = () => true;
  // sharing with Claude: the phone's share sheet, or the clipboard anywhere else
  navigator.share = async d => { window.__shared = d.text; };
  if (navigator.clipboard) navigator.clipboard.writeText = async t => { window.__shared = t; };
};

// The README's phone shots, written only when asked (SHOTS=1 npm test), so a plain run leaves the repo as it was. A shot
// waits for any message to go first, so none is caught on the picture.
const shot = async (pg, name) => {
  await pg.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 8000 });
  if (process.env.SHOTS === '1') await pg.screenshot({ path: join(root, `docs/${name}.png`) });
};

const g = fakeGoogle();
const browser = await pw.chromium.launch();
// Every file a page asks this server for, on every device: each one has to be in the offline copy (checked at the end).
const asked = new Set();
const newContext = browser.newContext.bind(browser);
browser.newContext = async o => {
  const c = await newContext(o);
  c.on('request', r => { const u = new URL(r.url()); if (u.origin === origin) asked.add(u.pathname); });
  return c;
};
async function device() {
  // No offline copy on these devices (it's checked on one of its own at the end): routes can't reach what a service worker
  // fetches, so it would hand the page sync.js without the stand-in Drive's address.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true, serviceWorkers: 'block' });
  await g.install(ctx, { rewrite: { '**/js/sync.js': s => s.replace("['https://parts-bin.junkdrawer.works', 'https://junkdrawer.works']", `['https://parts-bin.junkdrawer.works', '${origin}']`) } });
  await ctx.addInitScript(fakeNfc);
  // reference photos load from wherever they're hosted; here, one that exists and one that's gone
  await ctx.route('https://img.test/**', async r => (r.request().url().includes('missing') ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ contentType: 'image/png', body: await readFile(join(root, 'icon-192.png')) })));
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', e => page.problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.location().url.startsWith('https://img.test/')) page.problems.push(m.text()); });
  page.on('request', r => { const u = r.url(); if (!u.startsWith(base) && !u.startsWith('https://www.googleapis.com/') && !u.startsWith('https://accounts.google.com/') && !u.startsWith('https://img.test/')) page.problems.push('left the site: ' + u); });
  await page.goto(base);
  return { ctx, page };
}

// ---- phone: first open, load the Stockroom export
const { ctx, page } = await device();
await page.waitForSelector('text=No bins yet');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#imp')]);
await chooser.setFiles(exportFile);
await page.waitForSelector('text=Environmental');
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-scd41'].qty), 3);

// ---- Pack: type, pick the existing part, save, and the tag is written in the same flow
await page.goto(base + '#scan');
assert.match(await page.textContent('#main .note'), /^Bag it and type what it is/); assert.equal(await page.locator('details.packhelp').count(), 0);
await page.selectOption('#dest', 'bin-env');
await page.fill('#desc', 'bme');
await page.waitForSelector('.matchlist [data-id="p-bme280"]');
await page.click('.matchlist [data-id="p-bme280"]');
await page.waitForSelector('#p-name');
assert.equal(await page.inputValue('#p-bag'), '1');
await page.fill('#p-qty', '4');
await page.click('.sheet #save');
await page.waitForSelector('#tz.wait'); // listening for the sticker without another tap
// one bag after another: the way out says Skip the tag, and Write says it's waiting (a tap on it starts again)
assert.equal(await page.textContent('.sheet #done'), 'Skip the tag');
assert.equal((await page.textContent('.sheet #write')).trim(), 'Waiting for the sticker…');
assert.ok(await page.evaluate(() => window.__tap()));
await page.waitForSelector('#tz.ok');
const okAt = Date.now();
assert.match((await page.evaluate(() => window.__written))[0], /#bag\/001$/);
// a tick, what to do next, and Next bag; it closes by itself in about 1.6 s
assert.equal(await page.textContent('#t-status'), 'Tagged. Write #001 on the bag.');
assert.equal(await page.locator('#tz .tz-icon path[d="M5 12.5l4.5 4.5L19 7"]').count(), 1);
await page.waitForFunction(() => document.querySelector('.sheet #done')?.textContent === 'Next bag');
await page.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 2500 });
assert.ok(Date.now() - okAt > 1000, 'the tag sheet closed before "Tagged." could be read');
const bme = await page.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-bme280']);
assert.equal(bme.qty, 4); assert.equal(bme.bag, 1); assert.equal(bme.tagWritten, true);
// once this browser has packed a bag, how Pack works folds away to one line, so the field sits higher
assert.equal(await page.textContent('details.packhelp summary'), 'How Pack works'); assert.equal(await page.locator('#main .note').count(), 0);
assert.match(await page.textContent('details.packhelp'), /Bag it and type what it is/);
// next bag number moves on, with the description and its matches cleared for it
assert.match(await page.textContent('.packhead .big'), /#002/);
assert.equal(await page.inputValue('#desc'), ''); assert.equal(await page.locator('.matchlist').count(), 0);

// ---- a new part through the same flow
await page.fill('#desc', 'Soldering iron');
await page.click('.matchlist [data-id=""]');
await page.click('.sheet #save');
await page.waitForSelector('#tz.wait');
await page.evaluate(() => window.__tap());
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.match((await page.evaluate(() => window.__written))[1], /#bag\/002$/);
await page.evaluate(() => scrollTo(0, 0)); // typing took the field to the top of the screen: the README shows the whole of Pack
await shot(page, 'phone-pack');

// ---- Parts → + Part: a new part goes into a new bag and is tagged on save
await page.goto(base + '#parts');
await page.click('#addp');
await page.fill('#p-name', 'M3 heat-set inserts');
await page.fill('#p-qty', '50');
assert.ok(await page.isChecked('#p-dotag'));
assert.equal(await page.textContent('#p-bagshow'), '#003');
assert.equal(await page.textContent('.sheet #save'), 'Save & tag');
await page.click('.sheet #save');
await page.waitForSelector('#tz.wait');
await page.evaluate(() => window.__tap());
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.match((await page.evaluate(() => window.__written)).at(-1), /#bag\/003$/);
const ins = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(x => x.name === 'M3 heat-set inserts'));
assert.equal(ins.bag, 3); assert.equal(ins.qty, 50); assert.equal(ins.tagWritten, true);
// unticking it saves without a bag or a tag (ticking it again brings the number back)
await page.click('#addp');
await page.fill('#p-name', 'Loose spare');
assert.equal(await page.inputValue('#p-bag'), '4');
await page.uncheck('#p-dotag');
assert.equal(await page.inputValue('#p-bag'), '', 'unticked, the bag number it filled in goes');
await page.check('#p-dotag');
assert.equal(await page.inputValue('#p-bag'), '4');
await page.uncheck('#p-dotag');
await page.click('.sheet #save');
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.equal((await page.evaluate(() => window.__written)).length, 3);
assert.ok(!(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(x => x.name === 'Loose spare').bag)), 'saved without a bag');

// ---- Bag tag on the page of a part that has no bag yet: it gets the next number, and the tag carries it
const spareId = await page.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(([, x]) => x.name === 'Loose spare')[0]);
const spare = () => page.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], spareId);
await page.goto(base + '#part/' + spareId);
assert.equal((await page.textContent('#bagtag')).trim(), 'Bag tag'); assert.equal(await page.locator('.bagbadge').count(), 0);
await page.click('#bagtag');
assert.match(await page.textContent('.sheet h3'), /#004/);
assert.match(await page.textContent('.sheet'), /This will be bag #004/);
// looking at the sheet and backing out takes no number
assert.equal(await page.textContent('.sheet #done'), 'Cancel');
await page.click('.sheet #done');
assert.ok(!(await spare()).bag);
await page.click('#bagtag');
await page.click('.sheet #write');
await page.waitForSelector('#tz.wait');
await page.evaluate(() => window.__tap());
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.equal((await page.evaluate(() => window.__written)).at(-1), base + '#bag/004');
assert.equal((await spare()).bag, 4); assert.equal((await spare()).tagWritten, true);
assert.equal(await page.textContent('.binhead .bagno'), '#004');
// the page says the bag has its tag now (it looked the same with or without one)
await page.waitForSelector('.bagbadge .tagged');
assert.equal(await page.textContent('.bagbadge .tagged'), 'tagged'); assert.equal(await page.getAttribute('.bagbadge', 'aria-label'), 'Bag #004, tag written');
assert.equal((await page.textContent('#bagtag')).trim(), 'Rewrite tag');
// if the number is taken while the sheet is open (another tab, a sync), it stops rather than double up
await page.goto(base + '#parts'); await page.click('#addp'); await page.fill('#p-name', 'Second spare'); await page.uncheck('#p-dotag'); await page.click('.sheet #save');
await page.waitForFunction(() => !document.querySelector('.sheet'));
const second = await page.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(([, x]) => x.name === 'Second spare')[0]);
await page.goto(base + '#part/' + second); await page.click('#bagtag');
assert.match(await page.textContent('.sheet h3'), /#005/);
await page.evaluate(id => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts.stolen = { name: 'Took the number', bag: 5, qty: 1, t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); }, second);
await page.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts.stolen);
await page.waitForTimeout(100);
await page.click('.sheet #write');
await page.waitForSelector('text=has just been used');
assert.ok(!(await page.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].bag, second)));
assert.equal(await page.evaluate(() => window.__tap()), false, 'nothing was waiting to be written');
// put things back so the bag numbers below read on from #004
await page.evaluate(id => { const d = JSON.parse(localStorage.getItem('parts-bin')); delete d.items.parts.stolen; delete d.items.parts[id]; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); }, second);
await page.waitForTimeout(100);
await page.goto(base + '#part/' + spareId);
// tagging it again keeps its number. From a part's page there's no next bag: the sheet says Close, then Done
await page.click('#bagtag');
assert.equal(await page.textContent('.sheet #done'), 'Close');
await page.click('.sheet #write');
await page.waitForSelector('#tz.wait');
assert.equal((await page.textContent('.sheet #write')).trim(), 'Waiting for the sticker…');
await page.click('.sheet #write'); assert.ok(await page.evaluate(() => window.__waiting()), 'a tap on Waiting stopped it listening');
await page.evaluate(() => window.__tap());
await page.waitForSelector('#tz.ok');
await page.waitForFunction(() => document.querySelector('.sheet #done')?.textContent === 'Done');
// a tap anywhere closes it sooner, and the message after it still shows
const tapAt = Date.now(); await page.click('.sheet h3');
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.ok(Date.now() - tapAt < 1000, 'a tap left the tag sheet open');
await page.waitForSelector('#toast:has-text("#004 tagged")');
assert.equal((await page.evaluate(() => window.__written)).at(-1), base + '#bag/004');
assert.equal((await spare()).bag, 4);

// ---- reading a tag opens that bag, with no tap first: the page listens while it's open
await page.goto(base + '#bins');
await page.reload();
await page.waitForFunction(() => window.__reader?.onreading);
assert.ok(await page.$('#readtag.on'), 'the NFC button shows it is listening');
assert.equal(await page.getAttribute('#readtag', 'aria-pressed'), 'true', 'only the look says it is listening');
await page.evaluate(u => window.__read(u), base + '#bag/001');
await page.waitForSelector('h2:has-text("BME280")');
// an old tag from the Stockroom artifact opens here too, and offers to rewrite it for Parts Bin
await page.goto(base + '#bins');
await page.evaluate(() => window.__read('https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/001'));
await page.waitForSelector('h2:has-text("BME280")');
await page.waitForSelector('.sheet:has-text("Update this tag?")');
// read again as it's held: it's the bag open behind the sheet, so nothing says to close it
await page.evaluate(() => window.__read('https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#bag/001'));
await page.waitForTimeout(200); assert.equal(await page.locator('#toast:has-text("Close this")').count(), 0, 'it said to close the sheet to open the bag behind it');
await page.click('.sheet #go');
await page.waitForSelector('#tz.wait');
// the bag has its number already: the sheet says to keep the sticker there, not to write the number on the bag
assert.equal(await page.textContent('.sheet p.muted'), 'Keep it at the top of the phone: this sticker gets the new link.');
await page.evaluate(() => window.__tap());
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.equal((await page.evaluate(() => window.__written)).at(-1), base + '#bag/001');
// the tag just written, still against the phone, doesn't bounce the page around
await page.goto(base + '#bins');
await page.evaluate(u => window.__read(u), base + '#bag/001');
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => location.hash), '#bins');
await page.waitForTimeout(3000);
// an old tag for a part with no bag yet says the bag number it will get
await page.evaluate(() => window.__read('https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG#part/p-scd41'));
await page.waitForSelector('.sheet:has-text("Update this tag?")');
assert.match(await page.textContent('.sheet p.muted'), /Rewrite it to open Parts Bin instead\. It’ll become bag #00\d\. Keep it at the top of the phone\.$/);
await page.click('.sheet #later'); await page.waitForFunction(() => !document.querySelector('.sheet'));
await page.goto(base + '#bins');
// another project's tag is left alone, though it reads #part/ or #bag/ as well: another junkdrawer.works tool's,
// someone's GitHub page, a look-alike address (they opened here, as Part not found, or as a bin or bag of yours)
for (const u of ['https://kerf.junkdrawer.works/#part/abc', 'https://brickyard.junkdrawer.works/#bin/bin-env', 'https://someone.github.io/thing/#bag/001', 'https://notjunkdrawer.works/parts-bin/#bag/001']) {
  await page.goto(base + '#parts'); await page.goto(base + '#bins'); await page.waitForFunction(() => window.__reader?.onreading);
  await page.evaluate(u => window.__read(u), u);
  await page.waitForSelector('#toast:not([hidden]):has-text("That tag isn’t one of yours")');
  assert.equal(await page.evaluate(() => location.hash), '#bins', u + ' opened here');
}
// every address Parts Bin has written on a tag still opens it: its own, its old one at junkdrawer.works/parts-bin/ (and
// GitHub's address for that), with or without index.html
for (const [u, head] of [['https://junkdrawer.works/parts-bin/#bag/001', 'BME280'], ['https://parts-bin.junkdrawer.works/#bin/bin-env', 'Environmental'], ['https://junkdrawerworks.github.io/parts-bin/#bag/001', 'BME280'], ['https://www.junkdrawer.works/parts-bin/index.html#part/p-scd41', 'SCD41'], [base + 'index.html#bin/bin-env', 'Environmental']]) {
  await page.goto(base + '#bins'); await page.waitForFunction(() => window.__reader?.onreading);
  await page.evaluate(u => window.__read(u), u);
  await page.waitForSelector(`h2:has-text("${head}")`);
}
// a bag link with no number in it says so (it read "No bag " and "No part has bag  now")
await page.goto(base + '#bag/1x'); await page.waitForSelector('.empty h3');
assert.equal(await page.textContent('.empty h3'), 'No bag number'); assert.equal(await page.textContent('.empty p'), 'That tag doesn’t name a bag number.');
assert.equal(await page.locator('.empty #find').count(), 1);
await page.goto(base + '#bins');
// someone else's link is left alone
await page.evaluate(() => window.__read('https://example.com/#bag/001'));
await page.waitForSelector('text=That tag isn’t one of yours');
assert.equal(await page.evaluate(() => location.hash), '#bins');
// and the message is about Bins, so it goes when another screen opens (it stayed up over BOM check)

// ---- BOM check against the inventory
await page.goto(base + '#bom');
assert.ok(await page.evaluate(() => document.getElementById('toast').hidden), 'the tag message followed onto BOM check');
await page.selectOption('#proj', 'proj-x');
await page.waitForSelector('.bom-summary');
const summary = await page.textContent('.bom-summary');
assert.match(summary, /2 have/); assert.match(summary, /1 missing/);
// where each part is: its bin, and the bag in it (the bag was left out)
assert.match(await page.textContent('.bom-table tbody tr:first-child td:nth-child(4)'), /^ENV #001\s*Environmental$/);
// the examples above the list read as they're typed, not uppercased like the label (2X XIAO ESP32-S3)
assert.equal(await page.$eval('.field label code', c => getComputedStyle(c).textTransform), 'none');
await shot(page, 'phone-bom');
// a saved BOM picked shows Rename…, Delete, Save changes and Save as new…; with none picked, Save this BOM
const savedBoms = () => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.projects).filter(p => !p.del).length);
const bomNamed = name => page.evaluate(name => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.projects).find(([, p]) => p.name === name)?.[0], name);
const bomButtons = () => page.$$eval('#rename, #delbom, #update, #saveas, #savebom', bs => bs.map(b => b.textContent + (b.disabled ? ' (off)' : '')));
assert.deepEqual(await bomButtons(), ['Rename…', 'Delete', 'Save changes (off)', 'Save as new…']);
await page.selectOption('#proj', '');
assert.deepEqual(await bomButtons(), ['Save this BOM']);
assert.equal(await page.inputValue('#bom'), '2 BME280\n1 SCD41\n1 SGP30', 'the list stays in the box');
// Save this BOM with nothing in the box saves nothing and says what to do (an empty BOM was saved under the name typed)
const bomsBefore = await savedBoms();
await page.fill('#bom', '  \n');
await page.click('#savebom');
await page.waitForSelector('#toast:has-text("Paste a parts list first")');
assert.equal(await page.locator('.sheet').count(), 0, 'it asked for a name for an empty BOM'); assert.equal(await savedBoms(), bomsBefore);
// a list typed but not checked yet stays through another screen, a reload, and Save this BOM
await page.fill('#bom', '1 SCD41\n2 heat-set inserts');
await page.click('#tabbar [data-go="parts"]'); await page.waitForSelector('#cat');
await page.click('#tabbar [data-go="bom"]'); await page.waitForSelector('#bom');
assert.equal(await page.inputValue('#bom'), '1 SCD41\n2 heat-set inserts');
await page.reload(); await page.waitForSelector('#bom');
assert.equal(await page.inputValue('#bom'), '1 SCD41\n2 heat-set inserts');
await page.fill('#bom', '3 WS2812 strip segment');
// it's named in a sheet in the page's own style (the browser's prompt asked "Name this BOM:"), which needs a name
await page.click('#savebom');
await page.waitForSelector('.sheet #b-name');
assert.equal(await page.textContent('.sheet h3'), 'Save this BOM');
await page.click('.sheet #save');
await page.waitForSelector('#toast:has-text("Give the BOM a name")');
await page.fill('.sheet #b-name', 'Lamp'); await page.click('.sheet #save');
await page.waitForFunction(() => !document.querySelector('.sheet'));
// it says which, as a BOM, and the picker shows it once the screen is drawn again (it went back to "Saved BOMs…")
await page.waitForSelector('#toast:has-text("BOM saved: Lamp")');
const lampId = await bomNamed('Lamp');
await page.waitForFunction(id => document.getElementById('proj').value === id, lampId, { timeout: 2000 }).catch(() => assert.fail('the saved BOM isn’t picked'));
await page.waitForTimeout(100);
assert.equal(await page.inputValue('#proj'), lampId);
assert.equal(await page.inputValue('#bom'), '3 WS2812 strip segment');
assert.deepEqual(await bomButtons(), ['Rename…', 'Delete', 'Save changes (off)', 'Save as new…']);
// an edit keeps it picked (the menu went back to "Saved BOMs…"), and Save changes writes the list over it: no second copy
const n0 = await savedBoms();
await page.fill('#bom', '3 WS2812 strip segment\n1 SCD41');
assert.equal(await page.inputValue('#proj'), lampId);
assert.deepEqual(await bomButtons(), ['Rename…', 'Delete', 'Save changes', 'Save as new…']);
await page.click('#update');
await page.waitForSelector('#toast:has-text("BOM saved: Lamp")');
await page.waitForFunction(id => JSON.parse(localStorage.getItem('parts-bin')).items.projects[id].text === '3 WS2812 strip segment\n1 SCD41', lampId);
assert.equal(await savedBoms(), n0);
await page.waitForFunction(() => document.getElementById('update')?.disabled);
// and through a reload
await page.reload(); await page.waitForSelector('#proj');
assert.equal(await page.inputValue('#proj'), lampId, 'a reload forgot which BOM it was');
// Rename… renames it in place
await page.click('#rename'); await page.waitForSelector('.sheet #b-name');
assert.equal(await page.inputValue('.sheet #b-name'), 'Lamp');
await page.fill('.sheet #b-name', 'Lamp v2'); await page.click('.sheet #save');
await page.waitForSelector('#toast:has-text("BOM renamed: Lamp v2")');
await page.waitForFunction(id => document.querySelector(`#proj option[value="${id}"]`)?.textContent === 'Lamp v2' && document.getElementById('proj').value === id, lampId);
assert.equal(await savedBoms(), n0);
// Save as new… makes a second BOM, under a name no other BOM has (the copies piled up under one name)
await page.fill('#bom', '3 WS2812 strip segment\n2 SCD41');
await page.click('#saveas'); await page.waitForSelector('.sheet #b-name');
assert.equal(await page.textContent('.sheet h3'), 'Save as a new BOM');
await page.click('.sheet #save');
await page.waitForSelector('#toast:has-text("A BOM called “Lamp v2” is saved already")');
await page.fill('.sheet #b-name', 'Lamp v3'); await page.click('.sheet #save');
await page.waitForSelector('#toast:has-text("BOM saved: Lamp v3")');
const v3 = await bomNamed('Lamp v3');
await page.waitForFunction(id => document.getElementById('proj').value === id, v3);
assert.equal(await savedBoms(), n0 + 1);
assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.projects[id].text, lampId), '3 WS2812 strip segment\n1 SCD41', 'the first one changed too');
// Delete deletes it the way a part is, so it goes from the other devices too, and the list stays in the box
page.once('dialog', d => { assert.equal(d.message(), 'Delete the BOM “Lamp v3”? The list stays in the box.'); d.accept(); });
await page.click('#delbom');
await page.waitForSelector('#toast:has-text("Deleted the BOM “Lamp v3”")');
assert.ok(await page.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.projects[id].del > 0, v3), 'no deletion to pass on');
assert.equal(await savedBoms(), n0);
await page.waitForFunction(() => document.getElementById('proj').value === '');
assert.deepEqual(await bomButtons(), ['Save this BOM']);
assert.equal(await page.inputValue('#bom'), '3 WS2812 strip segment\n2 SCD41');
// a long parts list (a KiCad export with footprints and datasheet links) is saved whole: it was cut to 4,000 characters
// on every load, mid-line, while the page said Saved
const longBom = Array.from({ length: 80 }, (_, i) => `1 R${i} 10k Resistor_SMD:R_0603_1608Metric https://example.com/datasheets/r${i}.pdf`).join('\n').slice(0, 5000);
assert.equal(longBom.length, 5000);
await page.fill('#bom', longBom);
await page.click('#savebom'); await page.fill('.sheet #b-name', 'Long board'); await page.click('.sheet #save');
await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.projects).some(p => p.name === 'Long board'));
await page.selectOption('#proj', '');
await page.fill('#bom', '3 WS2812 strip segment');
await page.reload(); await page.waitForSelector('#proj');
const longId = await bomNamed('Long board');
await page.selectOption('#proj', longId);
assert.equal(await page.inputValue('#bom'), longBom, 'the saved BOM came back cut short');
await page.selectOption('#proj', '');
await page.fill('#bom', '3 WS2812 strip segment');
// a shortfall in metres reads 0.2, not 0.19999999999999998, on screen and in the shopping list
await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts['p-heat'] = { name: 'Heat shrink tubing 3mm', qty: 0.1, unit: 'm', binId: 'bin-env', tags: [], t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
// and says what in: the unit is the part's, not part of the name (it read 0.2 × m heat shrink tubing 3mm)
await page.fill('#bom', '0.3 m heat shrink tubing 3mm'); await page.click('#check');
assert.equal(await page.textContent('.bom-table .chip.warn'), 'short 0.2 m');
assert.equal(await page.textContent('.bom-table tbody td.n'), '0.3 m');
// the arrow to the part it matched is read as "matched to", not "right arrow", and the table is named
assert.equal(await page.textContent('.bom-table tbody td:nth-child(2)'), 'heat shrink tubing 3mm→matched to Heat shrink tubing 3mm');
assert.equal(await page.getByRole('table', { name: 'BOM check results' }).count(), 1);
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '0.2 m heat shrink tubing 3mm');
// a line in centimetres against a part kept in metres, and a count with no unit, which is the part's
await page.fill('#bom', 'heat shrink tubing 3mm, 50cm\nheat shrink tubing 3mm, 0.1\n1 SCD41'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td.n:first-child', ts => ts.map(t => t.textContent)), ['0.5 m', '0.1 m', '1']);
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => c.textContent)), ['short 0.5 m', 'short 0.5 m', 'have']);
assert.equal(await page.textContent('.bom-table tbody tr:first-child td:nth-child(2) .tiny:last-child'), '0.6 m needed across 2 lines');
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '0.5 m heat shrink tubing 3mm');
// a length against a part counted in pieces is one piece: "2m USB-C cable" with one cable in stock has it (it said short
// 1 m), Need still reads 2 m, and two such lines are two cables, bought with the length they were asked for
const inject = (id, x) => page.evaluate(([id, x]) => { const d = JSON.parse(localStorage.getItem('parts-bin')); if (x) d.items.parts[id] = { tags: [], ...x, t: Date.now() }; else delete d.items.parts[id]; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); }, [id, x]);
await inject('p-cable', { name: 'USB-C cable', qty: 1, unit: 'pcs', binId: 'bin-env' });
await page.fill('#bom', '2m USB-C cable'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => c.textContent)), ['have']);
assert.equal(await page.textContent('.bom-table tbody td.n'), '2 m');
await page.fill('#bom', '2m USB-C cable\n1 m USB-C cable'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => c.textContent)), ['short 1', 'short 1']);
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '1 × 2 m USB-C cable');
await inject('p-cable', null);
// a near match (the part found lacks a value the line has: 5mm tubing finds the 3mm) says check in amber, not have: it's
// counted in its own total, isn't "You have everything", and goes on the shopping list with what was found (it said have,
// and the list left it off)
await page.fill('#bom', '0.1 m heat shrink tubing 5mm\n1 SCD41'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => [c.textContent, c.className])), [['check', 'chip warn'], ['have', 'chip ok']]);
assert.deepEqual(await page.locator('.bom-summary .chip').allTextContents(), ['1 have', '1 check']);
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '0.1 m heat shrink tubing 5mm (check: you have a Heat shrink tubing 3mm)');
await page.fill('#bom', '1 SCD41'); await page.click('#check');
assert.match(await page.textContent('.bom-summary'), /^You have everything for this\./, 'a sure match is as it was');
// a near match isn't counted in its part's need: the 0.1 m of 3mm in stock covers the 3mm line (it said short 0.1 m, the
// 5mm line counted in), and Built it takes only the 3mm line's 0.1 m, ticked
await page.fill('#bom', '0.1 m heat shrink tubing 3mm\n0.1 m heat shrink tubing 5mm'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => c.textContent)), ['have', 'check']);
await page.click('#out #built'); await page.waitForSelector('.sheet .built');
assert.deepEqual(await page.$$eval('.sheet .built label', ls => ls.map(l => [l.querySelector('.bn').textContent, l.querySelector('.bq').textContent, l.querySelector('input').checked])), [['Heat shrink tubing 3mm', '0.1 m → 0 m', true]]);
await page.click('.sheet #cancel'); await page.waitForFunction(() => !document.querySelector('.sheet'));
// two lines for one part are checked together: each fits the stock alone, but not both (both said have, and the shopping
// list left them out); the shortfall is bought once
const bmeStock = await page.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-bme280'].qty);
await page.fill('#bom', `${bmeStock - 1} BME280\nBME280 x2\n1 SCD41`); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => c.textContent)), ['short 1', 'short 1', 'have']);
assert.equal(await page.textContent('.bom-table tbody tr:first-child td:nth-child(2) .tiny:last-child'), `${bmeStock + 1} needed across 2 lines`);
assert.deepEqual(await page.locator('.bom-summary .chip').allTextContents(), ['1 have', '2 short']); // a count of none isn't shown
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '1 × BME280');
// a guide's headings are rows over the lines after them, not missing parts in the summary or the shopping list
await page.fill('#bom', 'Electronics\n1 SCD41\nSGP30\nHardware Supplies\n2 heat-set inserts\nFor this build you’ll need:'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody tr.sect th', ts => ts.map(t => [t.textContent, t.colSpan, t.scope])), [['Electronics', 5, 'colgroup'], ['Hardware Supplies', 5, 'colgroup'], ['For this build you’ll need', 5, 'colgroup']]);
assert.equal(await page.$$eval('.bom-table tbody tr:not(.sect)', rs => rs.length), 3);
assert.deepEqual(await page.locator('.bom-summary .chip').allTextContents(), ['2 have', '1 missing']);
// and the summary is said, as the table is drawn out of hearing below the button
await page.waitForFunction(() => document.getElementById('say').textContent === '2 have, 1 missing', null, { timeout: 2000 }).catch(() => assert.fail('BOM check said nothing'));
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '1 × SGP30');
// on a phone the shopping list can be copied from the top too, not only after every line (it was 4,400 px down a 40-line
// list), and each line is a card of two lines from the same table: need × item and its status, then what it matched, the
// stock and where it is, cut to fit (a five-column table wrapped a name over four lines)
await page.evaluate(() => { window.__shared = ''; });
await page.click('.bom-summary #copytop');
await page.waitForFunction(() => window.__shared === '1 × SGP30');
// a tap on a count shows only its lines (the 10 to order on a 40-line list, without scrolling past the 30 on hand), with
// a heading only while a line under it shows; a tap again shows every line, and so does a new list
const shownRows = () => page.$$eval('.bom-table tbody tr', rs => rs.filter(r => r.offsetParent).map(r => r.querySelector('.it, th').textContent));
await page.fill('#bom', 'Electronics\n1 SCD41\nSGP30\nHardware Supplies\n2 heat-set inserts'); await page.click('#check');
await page.click('.bom-summary [data-only="missing"]');
assert.deepEqual(await shownRows(), ['Electronics', 'SGP30']);
assert.equal(await page.getAttribute('.bom-summary [data-only="missing"]', 'aria-pressed'), 'true');
await page.waitForFunction(() => document.getElementById('say').textContent === 'Showing only 1 missing', null, { timeout: 2000 }).catch(() => assert.fail('the filter said nothing'));
await page.click('.bom-summary [data-only="have"]');
assert.deepEqual(await shownRows(), ['Electronics', 'SCD41', 'Hardware Supplies', 'heat-set inserts']);
await page.click('#check'); // checked again, it stays as it was
assert.deepEqual(await shownRows(), ['Electronics', 'SCD41', 'Hardware Supplies', 'heat-set inserts']);
await page.click('.bom-summary [data-only="have"]');
assert.equal((await shownRows()).length, 5);
assert.equal(await page.getAttribute('.bom-summary [data-only="have"]', 'aria-pressed'), 'false');
await page.click('.bom-summary [data-only="missing"]');
await page.fill('#bom', '1 SCD41\nSGP30\n1 BME280'); await page.click('#check');
assert.equal((await shownRows()).length, 3, 'a new list shows every line');
await page.fill('#bom', '1 SCD41 with a long description of the board it goes on, far wider than a phone\n1 SGP30'); await page.click('#check');
const card = await page.evaluate(() => { const r = document.querySelector('.bom-table tbody tr'), line = parseFloat(getComputedStyle(r.querySelector('td:nth-child(4)')).lineHeight) || 20, box = r.getBoundingClientRect(), chip = r.querySelector('.chip').getBoundingClientRect();
  return { grid: getComputedStyle(r).display, h: box.height, chipIn: chip.right <= box.right, where: r.querySelector('td:nth-child(4)').getBoundingClientRect().height, line, cells: r.cells.length, wide: document.documentElement.scrollWidth };});
assert.equal(card.grid, 'grid'); assert.ok(card.chipIn, 'the status is cut off'); assert.equal(card.cells, 5, 'a cell went'); assert.equal(card.wide, 390);
assert.ok(card.where <= card.line + 1, `where it is takes ${card.where} px, more than a line`);
assert.equal(await page.getByRole('cell', { name: 'missing' }).count(), 1, 'a missing line lost its status cell');
await page.fill('#bom', 'Electronics\n1 SCD41\nSGP30\nHardware Supplies\n2 heat-set inserts\nFor this build you’ll need:'); await page.click('#check');
// everything on hand says so, and which bins it's in, with no red "0 missing" (it showed three chips, two of them 0)
await page.fill('#bom', '3 BME280\n1 SCD41\nSCD41 x1'); await page.click('#check');
assert.equal(await page.textContent('.bom-summary'), 'You have everything for this. 2 parts, in ENVCopy pick list');
assert.equal(await page.locator('.bom-summary .chip, #out #copy').count(), 0);
assert.equal(await page.textContent('.bom-summary .label'), 'ENV');
await page.waitForFunction(() => document.getElementById('say').textContent === 'You have everything for this. 2 parts', null, { timeout: 2000 }).catch(() => assert.fail('BOM check didn’t say it has everything'));
// a pick list of the lines on hand, a bin a line with bag numbers, for gathering a build: a line that's short, missing or a
// near match isn't on it, two lines for one part are one entry, and a part not in a bin comes last
await page.evaluate(() => { window.__shared = ''; });
await page.click('.bom-summary #picktop');
await page.waitForFunction(() => window.__shared === 'ENV: 3× BME280 (Adafruit) #001, 2× SCD41');
await inject('p-loose2', { name: 'Hookup wire', qty: 5, unit: 'm' });
await page.fill('#bom', '1 BME280\n1 SCD41\nSGP30\n50cm hookup wire\n0.1 m heat shrink tubing 5mm\nSCD41 x1'); await page.click('#check');
await page.click('#out #pick');
await page.waitForFunction(() => window.__shared === 'ENV: 1× BME280 (Adafruit) #001, 2× SCD41\nNo bin: 0.5 m Hookup wire');
await inject('p-loose2', null);
// a parts list exported from KiCad or a shop's cart is read by its columns: no header row among the parts, the count from
// the count's column (a Digi-Key line's price was its count), and a KiCad value with its designators' kind
await page.fill('#bom', '"Reference","Value","Datasheet","Footprint","Qty"\n"U1,U2","BME280","~","Package_LGA:Bosch_LGA-8","2"\n"U3","SCD41","~","Sensor:Sensirion_SCD4x","1"\n"U4","SGP30","~","Sensor:Sensirion_DFN-6","1"'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody tr', rs => rs.map(r => [r.cells[0].textContent, r.querySelector('.it').textContent, r.cells[4].textContent])), [['2', 'BME280', 'have'], ['1', 'SCD41', 'have'], ['1', 'SGP30', 'missing']]);
await page.fill('#bom', 'Index,Quantity,Part Number,Manufacturer Part Number,Description,Customer Reference,Available,Backorder,Unit Price,Extended Price\n1,2,1528-SCD41-ND,SCD41,"SENSOR CO2 I2C",,2,0,49.50000,99.00'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td.n:first-child', ts => ts.map(t => t.textContent)), ['2']);
assert.equal(await page.textContent('.bom-table tbody .it'), 'SCD41, SENSOR CO2 I2C');
assert.equal(await page.textContent('.bom-table tbody td:last-child .chip'), 'have');
// Built it takes a checked list's parts out of stock in one go: a part a row with its count before and after, a short line
// takes what's there, a near match starts unticked, each part is written once, and Undo puts it all back
const qtyOf = id => page.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].qty, id);
const [bme0, scd0] = [await qtyOf('p-bme280'), await qtyOf('p-scd41')];
await page.fill('#bom', `2 BME280\n${scd0 + 1} SCD41\nSGP30\n0.1 m heat shrink tubing 5mm`); await page.click('#check');
await page.click('#out #built'); await page.waitForSelector('.sheet .built');
assert.deepEqual(await page.$$eval('.sheet .built label', ls => ls.map(l => [l.querySelector('.bn').textContent, l.querySelector('.bq').textContent, l.querySelector('input').checked])), [
  ['BME280 (Adafruit)', `${bme0} → ${bme0 - 2}`, true], [`SCD41only ${scd0} in stock`, `${scd0} → 0`, true], ['Heat shrink tubing 3mm fuzzy', '0.1 m → 0 m', false]]);
assert.equal(await page.textContent('.sheet #save'), 'Take 2 parts from stock');
await page.click('.sheet #save');
await page.waitForSelector('#toast:has-text("2 parts taken from stock")');
assert.deepEqual([await qtyOf('p-bme280'), await qtyOf('p-scd41'), await qtyOf('p-heat')], [bme0 - 2, 0, 0.1]);
await page.waitForFunction(n => document.querySelector('.bom-table tbody tr:first-child td:nth-child(3)')?.textContent === String(n), bme0 - 2, { timeout: 2000 }).catch(() => assert.fail('BOM check wasn’t checked again'));
await page.click('#toast button:has-text("Undo")');
await page.waitForSelector('#toast:has-text("2 parts put back in stock")');
assert.deepEqual([await qtyOf('p-bme280'), await qtyOf('p-scd41')], [bme0, scd0]);
// a part kept in two entries (Pack's "another bag of it") is one stock: the line has what they hold between them (matched
// to one entry it said short, and went on the shopping list), the pick list and Built it take the first bag, then the next
await inject('p-bme2', { name: 'BME280 (Adafruit)', qty: 4, unit: 'pcs', binId: 'bin-env', bag: 7 });
await page.fill('#bom', `${bme0 + 2} BME280\n1 SCD41`); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => c.textContent)), ['have', 'have']);
assert.deepEqual(await page.$$eval('.bom-table tbody tr:first-child td', ts => [ts[2].textContent, ts[3].textContent]), [String(bme0 + 4), 'ENV #001 #007']);
assert.equal(await page.textContent('.bom-summary'), 'You have everything for this. 2 parts, in ENVCopy pick list');
await page.evaluate(() => { window.__shared = ''; });
await page.click('.bom-summary #picktop');
await page.waitForFunction(t => window.__shared === t, `ENV: ${bme0}× BME280 (Adafruit) #001, 2× BME280 (Adafruit) #007, 1× SCD41`, { timeout: 2000 }).catch(async () => assert.fail('pick list: ' + await page.evaluate(() => window.__shared)));
await page.click('#out #built'); await page.waitForSelector('.sheet .built');
assert.deepEqual(await page.$$eval('.sheet .built label', ls => ls.map(l => [l.querySelector('.bn').textContent, l.querySelector('.bq').textContent, l.querySelector('input').checked])), [
  ['BME280 (Adafruit)2 entries: #001, #007', `${bme0 + 4} → 2`, true], ['SCD41', `${scd0} → ${scd0 - 1}`, true]]);
await page.click('.sheet #save');
await page.waitForSelector('#toast:has-text("2 parts taken from stock")');
assert.deepEqual([await qtyOf('p-bme280'), await qtyOf('p-bme2'), await qtyOf('p-scd41')], [0, 2, scd0 - 1]);
await page.click('#toast button:has-text("Undo")');
await page.waitForSelector('#toast:has-text("2 parts put back in stock")');
assert.deepEqual([await qtyOf('p-bme280'), await qtyOf('p-bme2'), await qtyOf('p-scd41')], [bme0, 4, scd0]);
await inject('p-bme2', null);
await page.fill('#bom', '0.3 m heat shrink tubing 3mm'); await page.click('#check'); // the list the clipboard check uses later

// ---- Inbox: a link from Claude brings parts to check; each is saved and tagged from its card
const IN = await import('../js/inbox.js');
const part = id => page.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
const partNamed = name => page.evaluate(name => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.parts).map(([id, x]) => ({ id, ...x })).find(x => x.name === name), name);
// one bag after another, as in Pack: Skip the tag, then Next bag (from a part's page: Close, then Done)
const tapTag = async (one = false) => { await page.waitForSelector('#tz.wait'); assert.equal(await page.textContent('.sheet #done'), one ? 'Close' : 'Skip the tag'); await page.evaluate(() => window.__tap()); await page.waitForFunction(t => document.querySelector('.sheet #done')?.textContent === t, one ? 'Done' : 'Next bag'); await page.waitForFunction(() => !document.querySelector('.sheet')); };
const photoLink = base + '#' + await IN.encode({ partsbin: 1, batch: { id: 'ptest-photo', name: 'Bench photo', source: 'photo', bin: 'ENV', items: [
  { name: 'SCD41 CO2 sensor', qty: 3, match: 'p-scd41', mpn: 'SCD41', iface: ['I2C'], addr: '0x62', volts: '2.4–5.5 V', logic: '3.3 V', img: 'https://img.test/scd41.png', check: 'Bench Identifier Port A should name it SCD41 at 0x62.' },
  { name: 'TCA9548A I2C multiplexer', qty: 2, category: 'Sensors', iface: 'iic', addr: '0x70–0x77', img: 'https://img.test/missing.png', onclick: 'alert(1)' },
  { name: 'Unmarked purple board', check: 'No markings to read. Bench Identifier Port A will name it if it’s I2C.' },
] } });
await page.goto(photoLink);
await page.waitForSelector('.batch .card.inb');
assert.equal(await page.evaluate(() => location.hash), '#inbox', 'the long code is gone from the address');
assert.ok(await page.isVisible('#toast:has-text("3 from Claude to check")'), 'the message about the batch went with the link');
assert.equal(await page.textContent('.batch .section-h .tiny'), 'From a photo · 3 left', 'no date when the batch has none');
assert.equal(await page.locator('.card.inb').count(), 3);
assert.equal(await page.textContent('#tabbar .badge'), '3');
await page.waitForFunction(() => document.querySelector('.card.inb[data-k="i0"] img.ref')?.naturalWidth > 0);
await shot(page, 'phone-inbox');
// the part Claude matched is offered first; picking it opens that record with its blanks filled, ready to tag
await page.click('.card.inb[data-k="i0"] button.pick');
await page.waitForSelector('.sheet #p-name');
assert.equal(await page.inputValue('#p-name'), 'SCD41');
assert.equal(await page.inputValue('#p-iface'), 'I2C'); assert.equal(await page.inputValue('#p-addr'), '0x62'); assert.equal(await page.inputValue('#p-qty'), '3');
assert.equal(await page.textContent('.sheet #save'), 'Save & tag');
await page.click('.sheet #save'); await tapTag();
assert.equal((await page.evaluate(() => window.__written)).at(-1), base + '#bag/005');
let scd = await part('p-scd41');
assert.equal(scd.bag, 5); assert.equal(scd.tagWritten, true); assert.deepEqual(scd.iface, ['I2C']); assert.equal(scd.img, 'https://img.test/scd41.png'); assert.match(scd.check, /Bench Identifier/); assert.deepEqual(scd.tags, ['generic']);
assert.equal(await page.locator('.card.inb').count(), 2);
// a new part opens filled in, in the bin the batch named
await page.click('.card.inb[data-k="i1"] [data-id=""]');
await page.waitForSelector('.sheet #p-name');
assert.equal(await page.inputValue('#p-name'), 'TCA9548A I2C multiplexer'); assert.equal(await page.inputValue('#p-bin'), 'bin-env'); assert.equal(await page.inputValue('#p-qty'), '2'); assert.equal(await page.inputValue('#p-iface'), 'I2C');
await page.click('.sheet #save'); await tapTag();
assert.equal((await page.evaluate(() => window.__written)).at(-1), base + '#bag/006');
const tca = await partNamed('TCA9548A I2C multiplexer');
assert.equal(tca.bag, 6); assert.equal(tca.binId, 'bin-env'); assert.equal(tca.addr, '0x70–0x77'); assert.equal(tca.onclick, undefined);
// a part Claude couldn't count says so on its card, and opens with the count empty: Save asks for it (it opened at 1, and
// saving said there was 1 of something nobody counted)
assert.equal(await page.textContent('.card.inb[data-k="i2"] .chip.warn'), 'count?');
await page.click('.card.inb[data-k="i2"] [data-id=""]'); await page.waitForSelector('.sheet #p-qty');
assert.equal(await page.inputValue('#p-qty'), ''); assert.equal(await page.textContent('#p-qtyhint'), 'Claude couldn’t count these. Count them before saving.');
await page.click('.sheet #save'); await page.waitForSelector('#toast:has-text("Count them first")');
assert.ok(await page.$('.sheet #p-qty'), 'the sheet stays open'); assert.equal(await page.evaluate(() => document.activeElement.id), 'p-qty');
assert.equal(await partNamed('Unmarked purple board'), undefined);
await page.click('.sheet #cancel'); await page.waitForFunction(() => !document.querySelector('.sheet'));
// skipping takes a card out and saves nothing; the batch's last card says what came of the batch (it went with no word)
await page.click('.card.inb[data-k="i2"] [data-a="skip"]');
await page.waitForSelector('text=Nothing waiting');
await page.waitForSelector('#toast:has-text("“Bench photo” done: 2 saved, 1 skipped")');
assert.equal(await page.locator('#tabbar .badge').count(), 0);
assert.equal(await partNamed('Unmarked purple board'), undefined);
// the same link again, on a fresh load, doesn't bring the batch back unless asked
await page.goto('about:blank'); await page.goto(photoLink);
await page.waitForSelector('#again');
assert.equal(await page.locator('.card.inb').count(), 0);
await page.click('#again'); await page.waitForSelector('.card.inb');
assert.equal(await page.locator('.card.inb').count(), 3);
// a batch loaded again is counted afresh: skip one, dismiss the rest, load it again and go through it
await page.click('.card.inb[data-k="i2"] [data-a="skip"]'); await page.waitForFunction(() => document.querySelectorAll('.card.inb').length === 2);
page.once('dialog', d => d.accept()); await page.click('[data-a="drop"]'); await page.waitForSelector('text=Nothing waiting');
await page.fill('#inb-paste', photoLink); await page.click('#inb-go'); await page.click('#again'); await page.waitForSelector('.card.inb'); // on the same visit
for (const k of ['i0', 'i1', 'i2']) await page.click(`.card.inb[data-k="${k}"] [data-a="skip"]`);
await page.waitForSelector('#toast:has-text("“Bench photo” done: 3 skipped")');
await page.goto('about:blank'); await page.goto(photoLink); await page.click('#again'); await page.waitForSelector('.card.inb');
assert.ok(await page.$(`.card.inb[data-k="i1"] [data-id="${tca.id}"]`), 'the part added a moment ago is offered as an existing one');
page.once('dialog', d => d.accept());
await page.click('[data-a="drop"]'); await page.waitForSelector('text=Nothing waiting');

// ---- suggested details for parts already here: pasted in, one field unticked, applied
await page.fill('#inb-paste', await IN.encode({ partsbin: 1, batch: { id: 'ptest-details', name: 'Details', source: 'details', items: [
  { id: 'p-bme280', category: 'Sensors', mpn: 'BME280', iface: ['I2C', 'SPI'], addr: '0x77, 0x76', volts: '3–5 V', notes: 'Bosch', tags: ['qwiic'] },
  { id: 'p-scd41', iface: ['I2C'], addr: '0x62' },
  { id: 'p-not-here', volts: '5 V' },
  { id: 'p-gone', name: 'INA219 (Adafruit)', addr: '0x40' }, // a rename for a part that isn't here: not a new part
] } }));
await page.click('#inb-go');
await page.waitForSelector('.diff');
assert.equal(await page.inputValue('#inb-paste'), '', 'the link that opened is still in the box');
assert.equal(await page.locator('.card.inb').count(), 1, 'a part that already says it all isn’t shown');
assert.deepEqual(await page.locator('.diff .k').allTextContents(), ['Part number', 'Interface', 'I2C address', 'Supply', 'Keywords', 'Notes']); // a tag is the NFC sticker
await page.uncheck('.diff input[data-k="notes"]');
await page.click('[data-a="apply"]');
await page.waitForSelector('#toast:has-text("Updated BME280 (Adafruit)")'); // which part, not "Updated 1 part"
// a suggestion for a part this browser doesn't have is kept and explained, until it's dismissed
await page.waitForSelector('.note.lost');
assert.equal(await page.locator('.card.inb').count(), 0); assert.equal(await page.textContent('#tabbar .badge'), '2');
// each is named (by its id when the suggestion has no name), with its own Skip
assert.match(await page.textContent('.note.lost p'), /^2 suggestions are for parts that aren’t in this browser’s inventory/);
assert.deepEqual(await page.locator('.note.lost .row .grow').allTextContents(), ['p-not-here', 'INA219 (Adafruit)']);
assert.equal(await page.locator('.note.lost .row .grow .mono').count(), 1);
await page.click('.note.lost .row:has-text("INA219") [data-a="skip"]');
await page.waitForFunction(() => document.querySelectorAll('.note.lost .row').length === 1);
assert.equal(await page.textContent('#tabbar .badge'), '1');
assert.match(await page.textContent('.note.lost p'), /^1 suggestion is for a part that isn’t in this browser’s inventory/);
page.once('dialog', d => d.accept());
await page.click('[data-a="drop"]'); await page.waitForSelector('text=Nothing waiting');
let bme2 = await part('p-bme280');
assert.equal(bme2.mpn, 'BME280'); assert.deepEqual(bme2.iface, ['I2C', 'SPI']); assert.equal(bme2.addr, '0x77, 0x76'); assert.equal(bme2.volts, '3–5 V'); assert.deepEqual(bme2.tags, ['qwiic']);
assert.ok(!bme2.notes, 'the unticked field was left alone'); assert.equal(bme2.qty, 4); assert.equal(bme2.bag, 1);
// a batch as a file, loaded from Settings, and everything in it applied at once
const moreFile = join(tmp, 'more.partsbin.json');
await writeFile(moreFile, JSON.stringify({ partsbin: 1, batch: { id: 'ptest-more', source: 'details', items: [
  { id: 'p-bme280', logic: '3.3 V or 5 V', check: 'Could be a BMP280. Bench Identifier Port A: ID 0x60 is a BME280.' },
  { id: 'p-scd41', link: 'https://sensirion.com/products/catalog/SCD41', notes: 'Photoacoustic' },
  { id: 'p-scd41', notes: 'Single-shot mode', tags: ['co2'] },
] } }));
await page.goto(base + '#settings');
const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#imp')]);
await chooser2.setFiles(moreFile);
await page.waitForSelector('[data-a="all"]');
assert.equal(await page.evaluate(() => location.hash), '#inbox');
await page.click('[data-a="all"]'); await page.waitForSelector('text=Nothing waiting');
bme2 = await part('p-bme280'); scd = await part('p-scd41');
assert.equal(bme2.logic, '3.3 V or 5 V'); assert.match(bme2.check, /BMP280/); assert.equal(scd.link, 'https://sensirion.com/products/catalog/SCD41');
assert.equal(scd.notes, 'Photoacoustic · Single-shot mode', 'two suggestions for one part build on each other'); assert.deepEqual(scd.tags, ['generic', 'co2']);

// ---- the part page shows the specs and a reference photo, and keeps what's still to check in view
await page.goto(base + '#part/p-scd41');
await page.waitForFunction(() => document.querySelector('.binhead .refphoto img.ref')?.naturalWidth > 0);
assert.deepEqual(await page.locator('.binhead .chip.spec').allTextContents(), ['I2C', '0x62', '2.4–5.5 V supply', '3.3 V logic']);
await page.click('.binhead .refphoto'); await page.waitForSelector('.sheet .refbig img'); await page.click('.sheet #done');
await page.click('#checked'); await page.waitForFunction(() => !document.querySelector('.checknote'));
assert.ok(!(await part('p-scd41')).check);
await page.goto(base + '#part/' + tca.id); // its photo is gone from the site it was on: the icon stays
await page.waitForFunction(() => !document.querySelector('.binhead img.ref') && !document.querySelector('.binhead .refphoto') && document.querySelector('.binhead .photo svg'));
await page.goto(base + '#parts'); await page.selectOption('#cat', '__check');
assert.deepEqual(await page.locator('.item .t').allTextContents(), ['BME280 (Adafruit)']);
await page.selectOption('#cat', '__bagged');
const bagged = await page.locator('.item .bagno').allTextContents();
assert.deepEqual(bagged, ['#001', '#002', '#003', '#004', '#005', '#006'], 'Bagged lists the parts in bag order');
await page.selectOption('#cat', '');
await page.fill('#q', '0x62'); await page.waitForFunction(() => document.querySelectorAll('.item').length === 1);
assert.equal(await page.textContent('.item .t'), 'SCD41'); await page.fill('#q', ''); await page.waitForFunction(() => document.querySelectorAll('.item').length > 1);
// nothing found says what was looked for, not "No parts here yet", with a way back, and offers it as a new part
await page.fill('#q', 'zzzz'); await page.waitForSelector('#main .empty:has-text("Nothing matches “zzzz”.")');
await page.click('#main .empty #addq'); await page.waitForSelector('.sheet #p-name');
assert.equal(await page.inputValue('#p-name'), 'zzzz'); await page.click('.sheet #cancel'); await page.waitForFunction(() => !document.querySelector('.sheet'));
await page.click('#main .empty #clearq'); await page.waitForFunction(() => document.querySelectorAll('.item').length > 1);
assert.equal(await page.inputValue('#q'), ''); assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
// with a category picked it says which, and offers them all; two letters aren't offered as a part
await page.selectOption('#cat', 'Sensors'); await page.fill('#q', 'zz'); await page.waitForSelector('#main .empty:has-text("No Sensors match “zz”.")');
assert.equal(await page.locator('#main .empty #addq').count(), 0);
await page.click('#main .empty #allcats'); await page.waitForSelector('#main .empty:has-text("Nothing matches “zz”.")');
assert.equal(await page.inputValue('#cat'), ''); await page.click('#main .empty #clearq');
await page.selectOption('#cat', '__low'); await page.waitForSelector('#main .empty:has-text("Nothing in “Low stock”.")');
await page.selectOption('#cat', '');
// on Bins, where bins are searched too, nothing found is one line, with no "Parts 0" heading under it
await page.goto(base + '#bins'); await page.fill('#q', 'qqq'); await page.waitForSelector('#main .empty:has-text("Nothing matches “qqq”.")');
assert.equal(await page.locator('#main .section-h').count(), 0); assert.ok(await page.isVisible('#main .empty #addq'));
assert.equal(await page.getAttribute('#q', 'placeholder'), 'Search parts, bins, bags');
await page.click('#main .empty #clearq'); await page.waitForSelector('.bin');
// a part that's gone says so, as a bin that's gone does, with the way to the rest (it said only "Part not found.")
await page.goto(base + '#part/p-no-such-part'); await page.waitForSelector('#main h3:has-text("Part not found")');
assert.match(await page.textContent('#main .empty p'), /^This tag or link points at a part that no longer exists\.$/);
await page.click('#main .empty #bk'); await page.waitForSelector('#cat');
// a change to a part another device has just deleted (the sync bringing the deletion in lands as the button is tapped)
// says so, and every button stays (it turned the whole page read-only for the visit and said "This view is read-only")
await page.goto(base + '#part/p-bme280'); await page.waitForSelector('#checked');
await page.evaluate(async () => { const { store } = await import('./js/store.js'); const x = store.doc.items.parts['p-bme280']; x.del = x.t + 1; });
await page.click('#checked'); await page.waitForSelector('#toast:has-text("That part was deleted on another device")');
await page.evaluate(async () => { const { store } = await import('./js/store.js'); store.reload(); }); // it's still in this browser's saved copy
await page.waitForSelector('#checked'); assert.ok(await page.isVisible('#edit') && await page.isVisible('#bagtag'));
assert.doesNotMatch(await page.textContent('#sidefoot'), /read-only/);
await page.goto(base + '#scan'); await page.waitForSelector('#desc');

// ---- a receipt adds to what's in stock, and a part that's already bagged isn't tagged again
await page.goto(base + '#' + await IN.encode({ partsbin: 1, batch: { id: 'ptest-receipt', name: 'Order 1234', made: '2026-11-23', source: 'receipt', items: [{ name: 'TCA9548A I2C multiplexer', qty: 3, match: tca.id }, { name: 'Mystery <b>board</b><img src=x onerror=window.__xss=1>', notes: '<i>hi</i>', volts: '5–32 V in', logic: '5 V tolerant' }] } }));
await page.waitForSelector('.card.inb[data-k="i1"]');
assert.deepEqual(await page.locator('.card.inb[data-k="i1"] .chip.spec').allTextContents(), ['5–32 V in', '5 V tolerant logic'], 'a supply that says "in" isn’t "in supply"');
assert.match(await page.textContent('.batch .section-h .tiny'), /^From a receipt · (23 Nov|Nov 23) · 2 left$/, 'the day Claude made it');
assert.equal(await page.locator('.card.inb .t b, .card.inb i, .card.inb img:not(.ref)').count(), 0, 'what a batch says is shown as text, never as markup');
assert.equal(await page.evaluate(() => window.__xss), undefined);
await page.click('.card.inb[data-k="i1"] [data-a="skip"]');
await page.click('.card.inb button.pick');
await page.waitForSelector('.sheet #p-name');
assert.equal(await page.inputValue('#p-qty'), '5'); assert.equal(await page.textContent('.sheet #save'), 'Save');
const wrote = (await page.evaluate(() => window.__written)).length;
await page.click('.sheet #save'); await page.waitForSelector('text=Nothing waiting');
assert.equal((await part(tca.id)).qty, 5); assert.equal((await page.evaluate(() => window.__written)).length, wrote);

// ---- asking Claude for details hands over the part, with its id so the answer finds its way back
const iron = await partNamed('Soldering iron');
await page.goto(base + '#part/' + iron.id);
await page.click('#ask');
const shared = await page.evaluate(() => window.__shared);
assert.match(shared, /^Parts Bin: fill in details for this part/);
assert.deepEqual(JSON.parse(shared.slice(shared.indexOf('{'))).parts.map(x => x.id), [iron.id]);
// with its bin and bag, so Claude can match a bag photo to it (the skill's script reads both)
assert.deepEqual(JSON.parse(shared.slice(shared.indexOf('{'))).parts[0], { id: iron.id, name: 'Soldering iron', bin: 'ENV', bag: '#002' });
await page.goto(base + '#part/p-scd41'); assert.equal(await page.locator('#ask').count(), 0, 'a part with details doesn’t ask');

// ---- a field unticked on one card stays unticked when another card is applied, and Apply all leaves it out (it applied
// everything, and drawing the Inbox again ticked it again)
await page.goto(base + '#inbox');
await page.fill('#inb-paste', await IN.encode({ partsbin: 1, batch: { id: 'ptest-untick', source: 'details', items: [
  { id: 'p-bme280', name: 'BME280 breakout (renamed)', link: 'https://www.adafruit.com/product/2652' },
  { id: tca.id, link: 'https://www.adafruit.com/product/2717' },
  { id: iron.id, notes: 'Pinecil' },
] } }));
await page.click('#inb-go'); await page.waitForSelector('[data-a="all"]:has-text("Apply all 3")');
await page.uncheck('.card.inb[data-k="i0"] .diff input[data-k="name"]');
await page.click('.card.inb[data-k="i1"] [data-a="apply"]');
await page.waitForSelector('[data-a="all"]:has-text("Apply all 2")');
assert.equal(await page.isChecked('.card.inb[data-k="i0"] .diff input[data-k="name"]'), false, 'drawn again, the box stays unticked');
assert.equal(await page.isChecked('.card.inb[data-k="i0"] .diff input[data-k="link"]'), true);
await page.click('[data-a="all"]'); await page.waitForSelector('text=Nothing waiting');
const bmeU = await part('p-bme280');
assert.equal(bmeU.name, 'BME280 (Adafruit)', 'the unticked name was left alone'); assert.equal(bmeU.link, 'https://www.adafruit.com/product/2652');
assert.equal((await part(tca.id)).link, 'https://www.adafruit.com/product/2717'); assert.equal((await part(iron.id)).notes, 'Pinecil');

// ---- a notes suggestion is added to long notes whole (they were cut to 4,000 characters, mid-word, and the suggestion
// lost), and notes too full to take it are left alone, the card saying so
const notesTo = async n => { await page.goto(base + '#part/' + iron.id); await page.click('#edit'); await page.fill('#p-notes', n); await page.click('#save'); await page.waitForFunction(([id, l]) => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].notes?.length === l, [iron.id, n.length]); };
const longNotes = 'Tip T12-K, holds 350 C fine. '.repeat(180).trim();
await notesTo(longNotes);
await page.goto(base + '#inbox');
await page.fill('#inb-paste', await IN.encode({ partsbin: 1, batch: { id: 'ptest-longnotes', source: 'details', items: [{ id: iron.id, notes: 'Needs 20 s warm-up after power on' }] } }));
await page.click('#inb-go'); await page.click('.card.inb [data-a="apply"]'); await page.waitForSelector('text=Nothing waiting');
assert.equal((await part(iron.id)).notes, longNotes + ' · Needs 20 s warm-up after power on');
await notesTo('n'.repeat(19990));
await page.goto(base + '#inbox');
await page.fill('#inb-paste', await IN.encode({ partsbin: 1, batch: { id: 'ptest-fullnotes', source: 'details', items: [{ id: iron.id, notes: 'Needs 20 s warm-up after power on', mpn: 'TS101' }] } }));
await page.click('#inb-go'); await page.waitForSelector('.card.inb .diff input[data-k="notes"]');
assert.ok(await page.isDisabled('.card.inb .diff input[data-k="notes"]') && !(await page.isChecked('.card.inb .diff input[data-k="notes"]')), 'notes too full to take it aren’t offered');
assert.match(await page.textContent('.card.inb .diff label.off'), /The notes are full \(20,000 characters\), so this can’t be added: Needs 20 s warm-up/);
await page.click('.card.inb [data-a="apply"]'); await page.waitForSelector('text=Nothing waiting');
assert.equal((await part(iron.id)).notes, 'n'.repeat(19990), 'the notes were left as they were'); assert.equal((await part(iron.id)).mpn, 'TS101');
await notesTo('Pinecil');

// ---- Drive: turn it on here, then a laptop picks the inventory up
await page.goto(base + '#settings');
await page.click('[data-a="on"]');
await page.waitForFunction(() => document.querySelector('#drivecard')?.textContent.includes('Saved to Google Drive') && /Last synced/.test(document.querySelector('#drivecard').textContent), null, { timeout: 10000 });
const file = () => g.files().find(f => f.appProperties?.partsbin === 'sync');
assert.ok(file(), 'a Parts Bin file in Drive');
assert.equal(JSON.parse(file().body).items.parts['p-bme280'].qty, 4);

const laptop = await device();
await laptop.page.goto(base + '#settings');
await laptop.page.click('[data-a="on"]');
await laptop.page.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin') || '{}').items?.parts?.['p-scd41']);
await laptop.page.goto(base + '#parts');
await laptop.page.waitForSelector('text=Soldering iron');
// the laptop changes a count; the phone gets it at its next sync
await laptop.page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); return d; });
await laptop.page.goto(base + '#part/p-scd41');
await laptop.page.click('#inc');
await laptop.page.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-scd41'].qty === 4);
await laptop.page.waitForFunction(() => document.querySelector('#cloud')?.dataset.s === 'ok', null, { timeout: 8000 });
await laptop.page.waitForTimeout(1600);
// meanwhile the phone is typing in Pack: the sync draws the screen again, and the description, its matches and the
// keyboard stay (it used to empty them)
await page.goto(base + '#scan'); await page.fill('#desc', 'scd'); await page.waitForSelector('.matchlist [data-id="p-scd41"]:has-text("in stock 3")');
await page.evaluate(() => document.querySelector('#cloud-m').click());
await page.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-scd41'].qty === 4, null, { timeout: 8000 });
await page.waitForSelector('.matchlist [data-id="p-scd41"]:has-text("in stock 4")');
assert.equal(await page.inputValue('#desc'), 'scd'); assert.equal(await page.evaluate(() => document.activeElement.id), 'desc');

// ---- a Drive file that isn't JSON at all is left alone, and the page says it can't read it (Drive itself is fine)
const BROKEN = '{"app":"parts-bin","items":{';
g.drive.files.fb1 = { owner: 'broken', name: 'Parts Bin', mimeType: 'application/vnd.google-apps.folder', appProperties: { partsbin: 'folder' }, version: 1, modified: Date.now(), body: null };
g.drive.files.fb2 = { owner: 'broken', name: 'Parts Bin.json', mimeType: 'application/json', appProperties: { partsbin: 'sync' }, parents: ['fb1'], version: 1, modified: Date.now(), body: BROKEN };
const other = await device();
await other.page.evaluate(() => localStorage.setItem('__who', 'broken'));
await other.page.goto(base + '#settings');
await other.page.click('[data-a="on"]');
await other.page.waitForFunction(() => /isn’t readable|Couldn’t reach/.test(document.querySelector('#drivecard')?.textContent), null, { timeout: 10000 });
assert.match(await other.page.textContent('#drivecard'), /The file in your Drive isn’t readable/);
assert.equal(g.drive.files.fb2.body, BROKEN, 'the file was left as it was');

// ---- with Drive on, a part deleted by mistake and loaded back from a backup stays (the next sync used to delete it again,
// as the deletion on Drive was newer than the backup's copy)
const until = async (f, what, ms = 10000) => { for (const end = Date.now() + ms; !(await f());) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise(r => setTimeout(r, 100)); } };
const onDrive = id => JSON.parse(file().body).items.parts[id];
const gone = x => !!(x && x.del && x.del >= (x.t || 0));
await page.goto(base + '#settings'); await page.waitForSelector('#exp');
const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#exp')]);
const bkFile = join(tmp, 'backup.json'); await bk.saveAs(bkFile);
await page.goto(base + '#part/p-scd41'); await page.click('#edit');
page.once('dialog', d => d.accept()); await page.click('.sheet #del'); await page.waitForFunction(() => location.hash === '#parts');
await until(() => gone(onDrive('p-scd41')), 'the deletion to reach Drive');
await page.goto(base + '#settings');
const [restore] = await Promise.all([page.waitForEvent('filechooser'), page.click('#imp')]);
await restore.setFiles(bkFile);
await page.waitForSelector('#toast:has-text("Loaded: 1 brought back that was deleted here")');
await until(async () => !gone(onDrive('p-scd41')) || gone(await part('p-scd41')), 'a sync after loading the file');
await page.waitForFunction(() => document.querySelector('#cloud')?.dataset.s === 'ok', null, { timeout: 8000 });
assert.ok(!gone(onDrive('p-scd41')), 'Drive has it back');
assert.ok(!gone(await part('p-scd41')), 'it stays on the phone after the sync');
await page.goto(base + '#part/p-scd41'); await page.waitForSelector('h2:has-text("SCD41")');
await laptop.page.evaluate(() => document.querySelector('#cloud').click());
await laptop.page.waitForFunction(() => { const x = JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-scd41']; return x && !(x.del >= x.t); }, null, { timeout: 8000 });
await page.evaluate(() => { document.getElementById('toast').hidden = true; });

// ---- a part deleted before a device's first sync, or while Drive was off, stays deleted when Drive comes on (it came
// back from the Drive copy for good: a first sync used to keep everything on both sides). Two devices of their own, on
// an account of their own.
{
  const A = await device(), B = await device();
  for (const d of [A, B]) await d.page.evaluate(() => localStorage.setItem('__who', 'firsts'));
  const theFile = () => g.files().find(f => f.owner === 'firsts' && f.appProperties?.partsbin === 'sync');
  const there = id => { const f = theFile(); return f && JSON.parse(f.body).items.parts[id]; };
  const here = (pg, id) => pg.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  const t0 = Date.now() - 3600000, seed = { app: 'parts-bin', v: 1, items: { bins: {}, projects: {}, parts: {
    'f-keep': { name: 'Kept part', qty: 1, t: t0 }, 'f-off': { name: 'Deleted with Drive off', qty: 2, t: t0 }, 'f-new': { name: 'Deleted before the first sync', qty: 3, t: t0 } } } };
  await A.page.evaluate(d => localStorage.setItem('parts-bin', JSON.stringify(d)), seed);
  await A.page.goto(base + '#settings'); await A.page.reload(); await A.page.click('[data-a="on"]');
  await until(() => there('f-new') && there('f-off'), 'the first device’s parts to reach Drive');
  // a new device with its own copy of the inventory (a backup loaded before Drive was on there), a part deleted in it
  await B.page.evaluate(d => { d.items.parts['f-new'] = { t: d.items.parts['f-new'].t, del: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); }, seed);
  await B.page.goto(base + '#settings'); await B.page.reload(); await B.page.click('[data-a="on"]');
  await until(() => gone(there('f-new')), 'the new device’s deletion to reach Drive');
  assert.ok(gone(await here(B.page, 'f-new')), 'it stays deleted on the new device');
  await A.page.evaluate(() => document.querySelector('#cloud').click());
  await until(async () => gone(await here(A.page, 'f-new')), 'the deletion to reach the first device');
  // Drive off on the first device, a part deleted, Drive on again
  await A.page.goto(base + '#settings'); await A.page.waitForSelector('[data-a="off"]');
  await A.page.click('[data-a="off"]'); await A.page.click('[data-a="off"]'); await A.page.waitForSelector('[data-a="on"]');
  await A.page.goto(base + '#part/f-off'); await A.page.click('#edit');
  A.page.once('dialog', d => d.accept()); await A.page.click('.sheet #del'); await A.page.waitForFunction(() => location.hash === '#parts');
  assert.ok(!gone(there('f-off')), 'nothing went to Drive while it was off');
  await A.page.goto(base + '#settings'); await A.page.click('[data-a="on"]');
  await until(() => gone(there('f-off')), 'the deletion made with Drive off to reach Drive');
  await A.page.waitForFunction(() => document.querySelector('#cloud')?.dataset.s === 'ok', null, { timeout: 8000 });
  assert.ok(gone(await here(A.page, 'f-off')), 'it stays deleted on the device it was deleted on');
  assert.ok(!gone(await here(A.page, 'f-keep')) && !gone(there('f-keep')), 'the part nobody deleted is still there');
  await A.page.goto(base + '#parts'); await A.page.waitForSelector('.item:has-text("Kept part")');
  assert.equal(await A.page.locator('.item:has-text("Deleted")').count(), 0);
  // a part deleted here and changed on the other device afterwards, before it heard of the deletion (Drive off there),
  // comes back, as the newer change wins, and the page says why it's back (it just reappeared)
  await B.page.goto(base + '#settings'); await B.page.waitForSelector('[data-a="off"]');
  await B.page.click('[data-a="off"]'); await B.page.click('[data-a="off"]'); await B.page.waitForSelector('[data-a="on"]');
  await A.page.goto(base + '#part/f-keep'); await A.page.click('#edit');
  A.page.once('dialog', d => d.accept()); await A.page.click('.sheet #del'); await A.page.waitForFunction(() => location.hash === '#parts');
  await until(() => gone(there('f-keep')), 'the deletion to reach Drive');
  await B.page.goto(base + '#part/f-keep'); await B.page.click('#inc');
  await until(async () => (await here(B.page, 'f-keep')).qty === 2, 'the other device’s change');
  await B.page.goto(base + '#settings'); await B.page.click('[data-a="on"]');
  await until(() => !gone(there('f-keep')) && there('f-keep').qty === 2, 'the other device’s change to reach Drive');
  await A.page.evaluate(() => document.querySelector('#cloud').click());
  await A.page.waitForSelector('#toast:has-text("Kept part came back: it was changed on another device after you deleted it here.")');
  await A.page.waitForSelector('.item:has-text("Kept part")');
  for (const d of [A, B]) { assert.deepEqual(d.page.problems, [], 'problems on the first-sync devices'); await d.ctx.close(); }
}

// ---- a backup from another device that has parts deleted there: loading it deletes nothing, and offers to delete here
// the ones not changed here since (moving a backup between two devices without Drive kept every part deleted on the first)
{
  const D = await device(), t0 = Date.now() - 3600000;
  await D.page.evaluate(d => localStorage.setItem('parts-bin', JSON.stringify(d)), { app: 'parts-bin', v: 1, items: { bins: {}, projects: {}, parts: {
    'k-a': { name: 'Deleted there', qty: 1, t: t0 }, 'k-b': { name: 'Changed here since', qty: 1, t: t0 + 50000 }, 'k-c': { name: 'Still everywhere', qty: 1, t: t0 } } } });
  await D.page.goto(base + '#settings'); await D.page.reload(); await D.page.waitForSelector('#imp');
  const fromThere = join(tmp, 'from-there.json');
  await writeFile(fromThere, JSON.stringify({ app: 'parts-bin', v: 1, items: { bins: {}, projects: {}, parts: {
    'k-a': { t: t0, del: t0 + 10000 }, 'k-b': { t: t0, del: t0 + 10000 }, 'k-c': { name: 'Still everywhere', qty: 1, t: t0 }, 'k-d': { name: 'New from there', qty: 2, t: t0 } } } }));
  const [ch] = await Promise.all([D.page.waitForEvent('filechooser'), D.page.click('#imp')]);
  await ch.setFiles(fromThere);
  await D.page.waitForSelector('#toast:has-text("Loaded: 1 item added or updated. This file has 1 part deleted on the device it came from; it’s still here.")');
  // a long message takes the phone's width, less a gutter, with its button under it (it was squeezed into the right half)
  const tb = await D.page.evaluate(() => { const t = document.getElementById('toast').getBoundingClientRect(), b = document.querySelector('#toast button').getBoundingClientRect(); return { l: t.left, r: innerWidth - t.right, under: b.top >= t.top + 30 }; });
  assert.ok(tb.l >= 15 && tb.l <= 17 && tb.r >= 15 && tb.r <= 17 && tb.under, JSON.stringify(tb));
  const kept = () => D.page.evaluate(() => Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.parts).map(([id, x]) => [id, !(x.del >= (x.t || 0))])));
  assert.deepEqual(await kept(), { 'k-a': true, 'k-b': true, 'k-c': true, 'k-d': true }, 'loading it deleted nothing');
  await D.page.click('#toast button:has-text("Delete that one too")');
  await D.page.waitForSelector('#toast:has-text("Deleted 1 part")');
  assert.deepEqual(await kept(), { 'k-a': false, 'k-b': true, 'k-c': true, 'k-d': true }, 'only the part not changed here since was deleted');
  assert.deepEqual(D.page.problems, []); await D.ctx.close();
}

// ---- a Drive request that never answers (a stalled connection) is given up, and the chip turns red instead of staying on
// "Syncing" until a reload; once the connection is back, Sync now works
await page.goto(base + '#part/' + iron.id); await page.waitForSelector('#inc');
await page.evaluate(() => { window.__driveTimeout = 300; });
await page.route('https://www.googleapis.com/upload/**', () => {}); // never answers
const ironQty = (await part(iron.id)).qty;
await page.click('#inc');
await page.waitForFunction(() => document.querySelector('#cloud-m').dataset.s === 'error', null, { timeout: 8000 });
await page.goto(base + '#settings');
assert.match(await page.textContent('#drivecard'), /Couldn’t reach Google Drive/);
assert.equal(await page.isEnabled('#drivecard [data-a="now"]'), true, 'Sync now can be tapped again');
await page.unroute('https://www.googleapis.com/upload/**');
await page.click('#drivecard [data-a="now"]');
await page.waitForFunction(() => document.querySelector('#cloud-m').dataset.s === 'ok', null, { timeout: 8000 });
assert.equal(onDrive(iron.id).qty, ironQty + 1, 'the count that waited reached Drive');
// A slow connection that's still getting somewhere isn't a stalled one: the file coming down in pieces, over longer than
// the wait, still syncs (a long inventory on one bar would otherwise never sync at all)
await page.evaluate(() => {
  window.__fetch0 = window.fetch; window.__media = 0;
  window.fetch = async (u, o = {}) => {
    const r = await window.__fetch0(u, o); if (!String(u).includes('alt=media')) return r;
    window.__media++;
    const bytes = new Uint8Array(await r.arrayBuffer()), size = Math.ceil(bytes.length / 6) || 1; let i = 0, t;
    const body = new ReadableStream({
      start(c) { o.signal?.addEventListener('abort', () => { clearTimeout(t); try { c.error(new DOMException('The operation was aborted.', 'AbortError')); } catch {} }); },
      pull(c) { return new Promise(res => { t = setTimeout(() => { if (i >= bytes.length) c.close(); else c.enqueue(bytes.slice(i, i += size)); res(); }, 150); }); },
    });
    return new Response(body, { status: r.status, headers: r.headers });
  };
});
await page.click('#drivecard [data-a="now"]');
await page.waitForFunction(() => window.__media > 0 && document.querySelector('#cloud-m').dataset.s !== 'busy', null, { timeout: 8000 });
assert.equal(await page.evaluate(() => document.querySelector('#cloud-m').dataset.s), 'ok', 'a file coming down slowly but steadily was given up on');
await page.evaluate(() => { window.fetch = window.__fetch0; delete window.__driveTimeout; });

// ---- with this browser's storage full, a sync that brings a change says it couldn't keep it (it said "Synced just now", and
// the change wasn't here)
await laptop.page.goto(base + '#part/' + iron.id); await laptop.page.waitForSelector('#inc');
await laptop.page.evaluate(() => document.querySelector('#cloud').click());
await laptop.page.waitForFunction(q => document.querySelector('#qv')?.value === String(q), ironQty + 1, { timeout: 8000 });
await laptop.page.click('#inc');
await until(() => onDrive(iron.id).qty === ironQty + 2, 'the laptop’s count to reach Drive');
const fullFor = (p, key, on) => p.evaluate(([key, on]) => {
  if (!on) { Storage.prototype.setItem = window.__setItem; return; }
  window.__setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { if (k === key) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return window.__setItem.call(this, k, v); };
}, [key, on]);
await page.goto(base + '#settings'); await page.waitForSelector('#drivecard [data-a="now"]');
await fullFor(page, 'parts-bin', true);
await page.click('#drivecard [data-a="now"]');
await page.waitForFunction(() => document.querySelector('#cloud-m').dataset.s === 'error', null, { timeout: 8000 });
assert.match(await page.textContent('#drivecard'), /This browser’s storage is full, so what Drive brought in wasn’t kept here\. Last synced [^.]+\.\s+Sync now/);
assert.doesNotMatch(await page.getAttribute('#cloud-m', 'title'), /Synced/);
assert.equal((await part(iron.id)).qty, ironQty + 1, 'the count here is what’s really kept');
await fullFor(page, 'parts-bin', false);
await page.click('#drivecard [data-a="now"]');
await page.waitForFunction(() => document.querySelector('#cloud-m').dataset.s === 'ok', null, { timeout: 8000 });
assert.equal((await part(iron.id)).qty, ironQty + 2);

// ---- two devices on one part a few minutes apart: Use one on the phone, then the laptop, left open on the part, adds a
// note. The laptop saved its note over its 5-minute-old copy, the phone's Use one was undone on every device, and nothing
// said so. Opening a sheet brings in what other devices saved first, and so does drawing a part's page from an old copy.
{
  const lp = laptop.page, lpart = id => lp.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  const lchip = () => lp.waitForFunction(() => document.querySelector('#cloud').dataset.s === 'ok', null, { timeout: 10000 });
  await lp.goto(base + '#part/' + iron.id); await lp.waitForSelector('#inc');
  await lp.evaluate(() => document.querySelector('#cloud').click()); await lchip();
  await page.goto(base + '#part/' + iron.id); await page.waitForSelector('#dec');
  const q0 = (await part(iron.id)).qty;
  assert.equal((await lpart(iron.id)).qty, q0, 'both start the same');
  await page.click('#dec');
  await until(() => onDrive(iron.id).qty === q0 - 1, 'the phone’s Use one to reach Drive');
  // the laptop's sheet brings it in before the note is saved
  await lp.click('#edit'); await lp.waitForSelector('.sheet #p-notes');
  await until(async () => (await lpart(iron.id)).qty === q0 - 1, 'the laptop to bring in the phone’s count when the sheet opened');
  await lp.fill('.sheet #p-notes', 'Runs from 3.3 V'); await lp.click('.sheet #save'); await lp.waitForFunction(() => !document.querySelector('.sheet'));
  await until(() => onDrive(iron.id).notes === 'Runs from 3.3 V', 'the laptop’s note to reach Drive');
  assert.equal(onDrive(iron.id).qty, q0 - 1, 'the phone’s Use one stayed');
  await page.evaluate(() => document.querySelector('#cloud').click());
  await page.waitForFunction(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].notes === 'Runs from 3.3 V', iron.id, { timeout: 10000 });
  assert.equal((await part(iron.id)).qty, q0 - 1);
  // a part's page drawn from a copy more than 30 s old brings in the newest before Add one is used on it
  await page.click('#dec'); await until(() => onDrive(iron.id).qty === q0 - 2, 'the phone’s second Use one to reach Drive');
  await lp.goto(base + '#parts'); await lp.waitForSelector('.list .item');
  await lp.evaluate(() => { const st = JSON.parse(localStorage.getItem('parts-bin.sync')); st.last = Date.now() - 60000; localStorage.setItem('parts-bin.sync', JSON.stringify(st)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin.sync' })); });
  await lp.goto(base + '#part/' + iron.id);
  await lp.waitForFunction(q => document.querySelector('#qv')?.value === String(q), q0 - 2, { timeout: 10000 });
  await lp.click('#inc'); await until(() => onDrive(iron.id).qty === q0 - 1, 'the laptop’s Add one to reach Drive');
  // and a bin's sheet: the phone renames the bin's place, the laptop changes its notes, and both stay
  await page.goto(base + '#bin/bin-env'); await page.click('#edit'); await page.fill('.sheet #f-loc', 'Shelf 3'); await page.click('.sheet #save');
  await page.waitForFunction(() => !document.querySelector('.sheet'));
  await until(() => JSON.parse(file().body).items.bins['bin-env'].location === 'Shelf 3', 'the phone’s bin to reach Drive');
  await lp.goto(base + '#bin/bin-env'); await lp.click('#edit'); await lp.waitForSelector('.sheet #f-notes');
  await until(() => lp.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.bins['bin-env'].location === 'Shelf 3'), 'the laptop to bring in the bin when its sheet opened');
  assert.equal(await lp.inputValue('.sheet #f-loc'), 'Workroom', 'what the sheet shows was drawn when it opened');
  await lp.fill('.sheet #f-notes', 'Top shelf'); await lp.click('.sheet #save'); await lp.waitForFunction(() => !document.querySelector('.sheet'));
  await until(() => JSON.parse(file().body).items.bins['bin-env'].notes === 'Top shelf', 'the laptop’s bin notes to reach Drive');
  assert.equal(JSON.parse(file().body).items.bins['bin-env'].location, 'Shelf 3', 'the phone’s change to the bin stayed');
  await page.evaluate(() => document.querySelector('#cloud').click()); await page.waitForFunction(() => document.querySelector('#cloud')?.dataset.s === 'ok', null, { timeout: 8000 });
}

// ---- Drive when it can't save: each way it goes wrong says what's really wrong and what to do (on a device of its own,
// with a Drive of its own)
{
  const { ctx: sCtx, page: sp } = await device();
  const card = () => sp.textContent('#drivecard'), chipIs = s => sp.waitForFunction(s => document.querySelector('#cloud-m').dataset.s === s, s, { timeout: 10000 });
  await sp.evaluate(() => localStorage.setItem('__who', 'states'));
  await sp.goto(base + '#settings'); await sp.click('[data-a="on"]');
  await sp.waitForFunction(() => /Last synced/.test(document.querySelector('#drivecard')?.textContent), null, { timeout: 10000 });
  const expire = async () => {
    await sp.evaluate(() => { const t = JSON.parse(localStorage.getItem('junkdrawer.google')); t.exp = Date.now() - 1000; localStorage.setItem('junkdrawer.google', JSON.stringify(t)); });
    await sp.reload(); await sp.waitForSelector('#drivecard [data-a="now"]'); await chipIs('tap'); await sp.waitForFunction(() => window.__cfg);
  };
  // signed out after the hour, and Google's window comes back without Drive allowed: the card and the button say to leave
  // the Drive box ticked (they said only that Google signs you out after an hour)
  await expire();
  assert.match(await card(), /Google signs you out after an hour/);
  await sp.evaluate(() => { window.__cfg.scope = 'email profile'; });
  await sp.click('#drivecard [data-a="now"]');
  await sp.waitForFunction(() => /leave the Drive box ticked/.test(document.querySelector('#drivecard').textContent));
  assert.match(await sp.getAttribute('#cloud-m', 'title'), /leave the Drive box ticked/);
  await sp.evaluate(() => { window.__cfg.scope = 'https://www.googleapis.com/auth/drive.file'; });
  await sp.click('#drivecard [data-a="now"]'); await chipIs('ok');
  assert.doesNotMatch(await card(), /leave the Drive box ticked/);
  // signed out again, and Google's window comes back with another of the person's accounts: nothing is read from or
  // written to that account's Drive (the whole inventory was copied into a new file there, while the card still named the
  // first account), and the card says which account is which
  await expire();
  await sp.evaluate(() => localStorage.setItem('__who', 'work'));
  const before = g.calls.length;
  await sp.click('#drivecard [data-a="now"]');
  await sp.waitForFunction(() => /You signed in as work@gmail\.com/.test(document.querySelector('#drivecard').textContent), null, { timeout: 10000 });
  assert.match(await card(), /You signed in as work@gmail\.com, but this device saves to states@gmail\.com’s Drive\. Sign in as states@gmail\.com, or stop saving here and turn it on again to use the other account\./);
  assert.match(await card(), /^\s*Google Drive: not synced/);
  assert.deepEqual(g.files().filter(f => f.owner === 'work'), [], 'a file was made in the other account’s Drive');
  assert.deepEqual(g.calls.slice(before).filter(c => !c.startsWith('GET /drive/v3/about')), [], 'the other account’s Drive was used');
  // a change saved meanwhile doesn't go there either, and the card still says why
  await sp.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin') || '{"app":"parts-bin","v":1,"items":{"bins":{},"parts":{},"projects":{}}}'); d.items.bins['b-w'] = { code: 'W1', name: 'Work', t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await sp.goto(base + '#bins'); await sp.click('.bin:has-text("Work")'); await sp.click('#edit'); await sp.fill('.sheet #f-name', 'Work bench'); await sp.click('.sheet #save');
  await sp.waitForTimeout(1600);
  await sp.goto(base + '#settings'); await sp.waitForSelector('#drivecard [data-a="now"]');
  assert.match(await card(), /You signed in as work@gmail\.com/);
  assert.deepEqual(g.files().filter(f => f.owner === 'work'), []);
  assert.equal(JSON.parse(await sp.evaluate(() => localStorage.getItem('parts-bin.sync'))).email, 'states@gmail.com');
  // the right account again: it syncs, and the change goes to that Drive
  await sp.evaluate(() => localStorage.setItem('__who', 'states'));
  await sp.click('#drivecard [data-a="now"]'); await chipIs('ok');
  assert.equal(JSON.parse(g.files().find(f => f.owner === 'states' && f.appProperties?.partsbin === 'sync').body).items.bins['b-w'].name, 'Work bench');
  // another junkdrawer.works project signs in as the other account, and its sign-in is shared: it isn't used here either
  // (it was taken on as it was, and the inventory went into that account's Drive)
  await sp.evaluate(() => { localStorage.setItem('junkdrawer.google', JSON.stringify({ token: 'tok-work', exp: Date.now() + 3600000, scope: 'https://www.googleapis.com/auth/drive.file', email: 'work@gmail.com' })); });
  await sp.reload(); await sp.waitForSelector('#drivecard [data-a="now"]'); await chipIs('tap'); await sp.waitForFunction(() => window.__cfg);
  const beforeShared = g.calls.length;
  await sp.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.bins['b-w'] = { ...d.items.bins['b-w'], name: 'Shared sign-in', t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await sp.waitForTimeout(1600);
  assert.deepEqual(g.calls.slice(beforeShared).filter(c => !c.startsWith('GET /drive/v3/about')), [], 'another project’s sign-in for the other account was used');
  assert.deepEqual(g.files().filter(f => f.owner === 'work'), [], 'a file was made in the other account’s Drive');
  await sp.click('#drivecard [data-a="now"]'); await chipIs('ok'); // signs in as this device's account
  assert.equal(JSON.parse(g.files().find(f => f.owner === 'states' && f.appProperties?.partsbin === 'sync').body).items.bins['b-w'].name, 'Shared sign-in');
  // Drive full: the card says so and that the inventory is kept here (it said to check the connection)
  const touch = name => sp.evaluate(name => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.bins['b-w'] = { ...d.items.bins['b-w'], name, t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); }, name);
  const driveSays = (status, reason) => ({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { errors: [{ domain: 'global', reason, message: reason }], code: status, message: reason } }) });
  const myFile = () => g.files().find(f => f.owner === 'states' && f.appProperties?.partsbin === 'sync' && !f.trashed);
  let writes = 0;
  await sp.route('https://www.googleapis.com/upload/**', r => (r.request().method() === 'OPTIONS' ? r.fallback() : (writes++, r.fulfill(driveSays(403, 'storageQuotaExceeded')))));
  await touch('Full drive'); await sp.click('#drivecard [data-a="now"]'); await chipIs('error');
  assert.match(await card(), /^\s*Google Drive: not synced.*Your Google Drive is full, so the inventory wasn’t saved there\. It’s kept on this device\. Free some space in Drive, then tap Sync now\. Last synced (just now|\d+ min ago)\./s);
  assert.equal(writes, 1, 'a full Drive isn’t asked again and again');
  await sp.unroute('https://www.googleapis.com/upload/**');
  // Drive busy: tried once more a few seconds later, then the card says so
  await sp.evaluate(() => { window.__driveBackoff = 200; });
  writes = 0;
  await sp.route('https://www.googleapis.com/upload/**', r => (r.request().method() === 'OPTIONS' ? r.fallback() : (writes++, r.fulfill(driveSays(429, 'rateLimitExceeded')))));
  await touch('Busy drive'); await sp.click('#drivecard [data-a="now"]'); await chipIs('error');
  assert.match(await card(), /Google Drive is busy\. Try again in a minute\./);
  assert.equal(writes, 2, 'tried once more');
  await sp.unroute('https://www.googleapis.com/upload/**');
  // busy only once (403 userRateLimitExceeded): the second go gets through
  writes = 0;
  await sp.route('https://www.googleapis.com/upload/**', r => (r.request().method() === 'OPTIONS' ? r.fallback() : ++writes === 1 ? r.fulfill(driveSays(403, 'userRateLimitExceeded')) : r.fallback()));
  await touch('Busy once'); await sp.click('#drivecard [data-a="now"]'); await chipIs('ok');
  assert.equal(JSON.parse(myFile().body).items.bins['b-w'].name, 'Busy once');
  await sp.unroute('https://www.googleapis.com/upload/**');
  // the file deleted on another device between finding it and writing it: one more go makes it afresh
  let gone404 = 0;
  await sp.route('https://www.googleapis.com/upload/drive/v3/files/**', r => { if (r.request().method() !== 'PATCH' || gone404++) return r.fallback(); g.drive.files[myFile().id].trashed = true; return r.fulfill(driveSays(404, 'notFound')); });
  const oldId = myFile().id;
  await touch('Made afresh'); await sp.click('#drivecard [data-a="now"]'); await chipIs('ok');
  assert.notEqual(myFile().id, oldId); assert.equal(JSON.parse(myFile().body).items.bins['b-w'].name, 'Made afresh');
  await sp.unroute('https://www.googleapis.com/upload/drive/v3/files/**');
  await sp.evaluate(() => { delete window.__driveBackoff; });
  // offline: a grey dot, not the red of something wrong, and the card says changes are kept here and when it last synced
  // (it said "Couldn't reach Google Drive. Check the connection")
  const dot = () => sp.$eval('#cloud-m .dot', d => getComputedStyle(d).backgroundColor);
  const grey = await sp.evaluate(() => { const i = document.createElement('i'); i.style.color = 'var(--ink3)'; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; });
  await sCtx.setOffline(true);
  await touch('Offline'); await sp.click('#drivecard [data-a="now"]'); await chipIs('offline');
  assert.match(await card(), /^\s*Saved to Google Drive.*Offline\. Changes are kept on this device and go to Drive when you’re back online\. Last synced (just now|\d+ min ago)\./s);
  assert.equal(await dot(), grey);
  assert.match(await sp.getAttribute('#cloud-m', 'title'), /^Offline\..*Last synced/);
  // Pack says the next bag number may be one another device has given out, and the line goes once it's back online
  // and synced
  await sp.goto(base + '#scan'); await chipIs('offline'); await sp.waitForSelector('.stale:not([hidden])');
  assert.match(await sp.textContent('.stale'), /^Not synced since [^.]+\. Sync first so this number isn’t one another device has used\.Sync now$/);
  // back online: it syncs by itself
  await sCtx.setOffline(false); await chipIs('ok');
  await sp.waitForSelector('.stale', { state: 'hidden' });
  await sp.goto(base + '#settings'); await sp.waitForSelector('#drivecard [data-a="now"]');
  assert.equal(JSON.parse(myFile().body).items.bins['b-w'].name, 'Offline');
  // a connection that drops as the file goes up reads as offline too
  await sp.route('https://www.googleapis.com/upload/**', r => r.abort('internetdisconnected'));
  await touch('Dropped'); await sp.click('#drivecard [data-a="now"]'); await chipIs('offline');
  await sp.unroute('https://www.googleapis.com/upload/**');
  await sp.click('#drivecard [data-a="now"]'); await chipIs('ok');
  // Drive answering something this page can't use isn't offline: that's for no connection (it said "Offline" for any
  // fault in the sync, with the phone online and nothing to bring it back)
  const listing = u => u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files';
  await sp.route(listing, r => (r.request().method() === 'GET' ? r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: '{"files":5}' }) : r.fallback()));
  await touch('Odd answer'); await sp.click('#drivecard [data-a="now"]'); await chipIs('error');
  assert.doesNotMatch(await card(), /Offline/);
  await sp.unroute(listing);
  await sp.click('#drivecard [data-a="now"]'); await chipIs('ok');
  // signed out: Pack's line has Sync now, which signs in from the tap; only the line changes, not what's being typed
  await expire();
  await sp.goto(base + '#scan'); await sp.waitForSelector('.stale:not([hidden])');
  await sp.fill('#desc', 'buzz'); await sp.evaluate(() => { window.__desc = document.getElementById('desc'); });
  await sp.click('.stale .btn'); await chipIs('ok');
  await sp.waitForSelector('.stale', { state: 'hidden' });
  assert.ok(await sp.evaluate(() => window.__desc === document.getElementById('desc') && window.__desc.value === 'buzz'), 'Pack was drawn again');
  assert.deepEqual(sp.problems.filter(p => !p.startsWith('Failed to load resource')), [], 'problems on the Drive states device'); // Drive saying no, as it was asked to
  await sCtx.close();
}

// ---- two devices packing at once, both online: a new part's sheet brings in what the other device has just packed, so
// the same bag number isn't given out twice (it was, almost every time: each device numbered from its last sync, and
// a save went to Drive only 1.2 seconds later)
{
  const A = await device(), B = await device();
  const partsOf = d => d.page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin') || '{"items":{"parts":{}}}').items.parts));
  for (const d of [A, B]) {
    await d.page.evaluate(() => localStorage.setItem('__who', 'pair'));
    await d.page.goto(base + '#settings'); await d.page.click('[data-a="on"]');
    await d.page.waitForFunction(() => document.querySelector('#cloud-m').dataset.s === 'ok' && /Last synced/.test(document.querySelector('#drivecard').textContent), null, { timeout: 10000 });
  }
  const pairFile = () => g.files().find(f => f.owner === 'pair' && f.appProperties?.partsbin === 'sync' && !f.trashed);
  const onPair = () => Object.values(JSON.parse(pairFile().body).items.parts);
  // A packs bag #001
  await A.page.click('#tabbar [data-go="parts"]'); await A.page.click('#addp');
  assert.equal(await A.page.textContent('#p-bagshow'), '#001');
  await A.page.fill('#p-name', 'Alpha sensor'); await A.page.click('.sheet #save');
  await A.page.waitForSelector('#tz.wait'); await A.page.evaluate(() => window.__tap()); await A.page.waitForFunction(() => !document.querySelector('.sheet'));
  await until(() => onPair().some(p => p.name === 'Alpha sensor' && p.bag === 1), 'A’s bag to reach Drive');
  // B, which last synced before that, opens a new part's sheet: it hands out #001 from what it has, and brings in A's bag
  await B.page.click('#tabbar [data-go="parts"]'); await B.page.click('#addp');
  assert.equal(await B.page.textContent('#p-bagshow'), '#001');
  await B.page.fill('#p-name', 'Beta sensor');
  await until(async () => (await partsOf(B)).some(p => p.name === 'Alpha sensor'), 'B to bring in A’s bag', 8000);
  // Save moves the number on before anything is saved, and the next tap saves it as #002
  await B.page.click('.sheet #save');
  await B.page.waitForSelector('#toast:has-text("Bag #001 was just used, so this is bag #002")');
  assert.equal(await B.page.inputValue('#p-bag'), '2');
  await B.page.click('.sheet #save');
  await B.page.waitForSelector('#tz.wait'); await B.page.evaluate(() => window.__tap()); await B.page.waitForFunction(() => !document.querySelector('.sheet'));
  assert.match((await B.page.evaluate(() => window.__written)).at(-1), /#bag\/002$/);
  assert.equal((await partsOf(B)).find(p => p.name === 'Beta sensor').bag, 2);
  await until(() => onPair().some(p => p.name === 'Beta sensor' && p.bag === 2), 'B’s bag to reach Drive');
  for (const d of [A, B]) { assert.deepEqual(d.page.problems, [], 'problems on two devices packing at once'); await d.ctx.close(); }
}

// ---- phone basics
await page.goto(base + '#bins');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');
await shot(page, 'phone-bins');
// the Drive button in the corner doesn't sit on top of a page's own buttons
const clear = sel => page.evaluate(sel => { const r = e => e.getBoundingClientRect(), c = r(document.querySelector('#cloud-m')), x = r(document.querySelector(sel)); return c.width > 0 && (x.right <= c.left || x.bottom <= c.top); }, sel);
await page.goto(base + '#part/p-bme280');
await page.waitForSelector('#edit');
assert.ok(await clear('#edit'), 'the Drive button covers Edit on a part page');
await page.goto(base + '#bin/bin-env');
await page.waitForSelector('#add');
assert.ok(await clear('#add'), 'the Drive button covers a button on a bin page');
// and on a phone every button is big enough for a fingertip: 44 px, 40 px for the small ones in a row, 44 by 44 for Back,
// the NFC button and the Drive button (WCAG 2.2 SC 2.5.5), and the bin and Product links reach 32 px
const box = sel => page.$$eval(sel, es => es.filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return [e.id || e.textContent.trim(), Math.round(r.width), Math.round(r.height)]; }));
const under = (list, w, h) => list.filter(([, x, y]) => x < w || y < h);
assert.deepEqual(under(await box('#back, #cloud-m'), 44, 44), [], 'a bin page’s Back or the Drive button is under 44 px');
assert.deepEqual(under(await box('.pagehead .btn.sm'), 0, 40), [], 'a bin page’s small buttons are under 40 px');
await page.goto(base + '#part/p-bme280'); await page.waitForSelector('#edit');
assert.deepEqual(under(await box('#back, .pagehead .btn.sm'), 0, 40), [], 'a part page’s buttons are under 40 px');
assert.deepEqual(under(await box('.binhead a'), 0, 32), [], 'the bin link on a part page is under 32 px');
await page.goto(base + '#bins'); await page.waitForSelector('#addbin');
assert.deepEqual(under(await box('#readtag'), 44, 44), [], 'the NFC button is under 44 px');
assert.deepEqual(under(await box('#addbin'), 0, 44), [], '+ Bin is under 44 px');
assert.ok(await page.evaluate(() => Math.abs(document.querySelector('.topbar h2').getBoundingClientRect().top - document.querySelector('.search').getBoundingClientRect().top) < 20), 'with the Drive button, search drops under the title');
// long names wrap rather than push the page sideways: a bin named in full (listed in a box's Unpack into), a saved BOM, a
// part name with no spaces
await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('parts-bin')), t = Date.now();
  d.items.bins['bin-long'] = { code: 'PWR', name: 'Power, regulators, buck and boost converters', location: 'Rack A, shelf 2', t };
  d.items.bins['box-long'] = { code: 'BOX 01', kind: 'box', name: 'Workroom — sensors, boards and the bench supplies', location: 'Moving boxes', t };
  d.items.parts['p-long'] = { name: 'Breakout-board-whose-name-goes-on-and-on-without-a-single-space', qty: 1, unit: 'pcs', binId: 'box-long', tags: [], t };
  d.items.projects['proj-long'] = { name: 'Workshop air quality monitor with e-ink display (v2)', text: '1 SCD41', t };
  localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' }));
});
for (const hash of ['#scan', '#inbox', '#parts', '#part/p-scd41', '#bins', '#bin/box-long', '#bom', '#part/p-long']) { await page.goto(base + hash); await page.waitForTimeout(150); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, hash + ' scrolls sideways on a phone'); }
await page.goto(base + '#bom'); const boxWas = await page.inputValue('#bom'); await page.selectOption('#proj', 'proj-long'); await page.waitForSelector('#rename');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'a long BOM name picked scrolls sideways on a phone');
await page.selectOption('#proj', ''); await page.fill('#bom', boxWas);
// every field writes at 16 px on a phone, as Safari on an iPhone zooms the page in on a field with smaller writing as soon
// as it's tapped: search, Pack, BOM check, the Inbox, a part's count, and the part and bin sheets
const smallFields = () => page.evaluate(() => [...document.querySelectorAll('input:not([type=file]):not([type=checkbox]),select,textarea')].filter(e => e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.tagName));
for (const hash of ['#bins', '#scan', '#inbox', '#bom', '#part/p-scd41']) { await page.goto(base + hash); await page.waitForTimeout(150); assert.deepEqual(await smallFields(), [], hash + ': a field under 16 px'); }
await page.click('#edit'); await page.waitForSelector('#p-name'); await page.$eval('.sheet details.more', d => { d.open = true; }); assert.deepEqual(await smallFields(), [], 'the part sheet: a field under 16 px'); await page.click('.sheet #cancel');
await page.goto(base + '#bin/bin-env'); await page.click('#edit'); await page.waitForSelector('#f-code'); assert.deepEqual(await smallFields(), [], 'the bin sheet: a field under 16 px'); await page.click('.sheet #cancel');
// a phone's keyboard leaves part names and numbers as typed (no autocorrect, no capital put first: xiao, ssd1306, 0x76),
// part numbers come up in capitals, bag numbers on the number pad, and counts on the one with a decimal point
const attrs = (sel, names) => page.$eval(sel, (e, n) => Object.fromEntries(n.map(k => [k, e.getAttribute(k)])), names);
const plain = { autocorrect: 'off', spellcheck: 'false' };
await page.goto(base + '#bins'); assert.deepEqual(await attrs('#q', ['autocorrect', 'autocapitalize', 'spellcheck', 'enterkeyhint']), { ...plain, autocapitalize: 'none', enterkeyhint: 'search' });
await page.goto(base + '#scan'); assert.deepEqual(await attrs('#desc', ['autocorrect', 'autocapitalize', 'spellcheck', 'enterkeyhint']), { ...plain, autocapitalize: 'none', enterkeyhint: 'go' });
await page.goto(base + '#part/p-scd41'); assert.equal(await page.getAttribute('#qv', 'inputmode'), 'decimal');
await page.click('#edit'); await page.waitForSelector('#p-name');
assert.deepEqual(await attrs('#p-mpn', ['autocorrect', 'autocapitalize', 'spellcheck']), { ...plain, autocapitalize: 'characters' });
assert.deepEqual(await attrs('#p-addr', ['autocorrect', 'autocapitalize', 'spellcheck']), { ...plain, autocapitalize: 'none' });
assert.deepEqual([await page.getAttribute('#p-bag', 'inputmode'), await page.getAttribute('#p-qty', 'inputmode'), await page.getAttribute('#p-min', 'inputmode')], ['numeric', 'decimal', 'decimal']);
await page.click('.sheet #cancel');
// names go by their numbers' value, in a bin's list and in what a search finds: #120 before #1000, M3 x 6 before M3 x 10
const sortParts = { 'p-s1000': 'Spacer #1000', 'p-s120': 'Spacer #120', 'p-m10': 'M3 x 10', 'p-m6': 'M3 x 6' };
const putSort = on => page.evaluate(([ps, on]) => { const d = JSON.parse(localStorage.getItem('parts-bin')), t = Date.now();
  if (on) { d.items.bins['bin-sort'] = { code: 'SRT', name: 'Sorting', t }; for (const [id, name] of Object.entries(ps)) d.items.parts[id] = { name, qty: 1, unit: 'pcs', binId: 'bin-sort', tags: [], t }; }
  else { delete d.items.bins['bin-sort']; for (const id in ps) delete d.items.parts[id]; }
  localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); }, [sortParts, on]);
await putSort(true);
await page.goto(base + '#bin/bin-sort'); await page.waitForSelector('.list .item');
assert.deepEqual(await page.$$eval('.list .item .t', e => e.map(x => x.textContent)), ['M3 x 6', 'M3 x 10', 'Spacer #120', 'Spacer #1000']);
await page.goto(base + '#bins'); await page.fill('#q', 'spacer'); await page.waitForSelector('.list .item:has-text("Spacer")');
assert.deepEqual(await page.$$eval('.list .item .t', e => e.map(x => x.textContent)), ['Spacer #120', 'Spacer #1000']);
await page.fill('#q', ''); await putSort(false); await page.waitForTimeout(300);
// a new part's hints read as examples, not as answers already filled in
await page.goto(base + '#parts'); await page.click('#addp'); await page.waitForSelector('#p-name');
assert.deepEqual([await page.getAttribute('#p-name', 'placeholder'), await page.getAttribute('#p-cat', 'placeholder')], ['e.g. Seeed XIAO ESP32-S3', 'e.g. Sensors']);
// a part's tags are its keywords: "tag" everywhere else is the NFC sticker (they sat under "Tag bag #002 when I save")
assert.equal(await page.textContent('label[for="p-tags"]'), 'Keywords (comma separated)'); assert.equal(await page.getAttribute('#p-tags', 'placeholder'), 'e.g. qwiic, 5V');
await page.click('.sheet #cancel');
// a sheet rises into place over a shade that fades in, and the tag zone's sign pulses while it listens; closing is instant.
// With less motion asked for (prefers-reduced-motion), nothing moves
const moving = () => page.evaluate(() => ['.sheet', '.sheet-bg', '#tz.wait .tz-icon'].map(q => document.querySelector(q)).map(e => e ? getComputedStyle(e).animationName : ''));
for (const reducedMotion of ['no-preference', 'reduce']) {
  await page.emulateMedia({ reducedMotion });
  await page.goto(base + '#part/p-scd41'); await page.click('#bagtag'); await page.click('.sheet #write'); await page.waitForSelector('#tz.wait');
  assert.deepEqual(await moving(), reducedMotion === 'reduce' ? ['none', 'none', 'none'] : ['sheet-up', 'sheet-bg-in', 'tz-pulse'], reducedMotion);
  await page.click('.sheet #done'); assert.equal(await page.locator('.sheet').count(), 0, 'a sheet lingers as it closes');
}
await page.emulateMedia({ reducedMotion: 'no-preference' });
// Pack with the keyboard up (a 470 px high screen stands in for it): tapping the field takes it to the top, so at least
// three matches show under it and above the keyboard (it sat 270 px down, with one or two showing). What was typed in it
// before is still there (a trip to a bag and back keeps it), so it's emptied first, without the keyboard.
await page.setViewportSize({ width: 390, height: 470 });
await page.goto(base + '#scan'); await page.waitForSelector('#desc');
await page.$eval('#desc', e => { e.value = ''; e.dispatchEvent(new Event('input')); });
await page.tap('#desc'); await page.keyboard.type('s'); await page.waitForSelector('.matchlist');
await page.waitForTimeout(450);
assert.ok(await page.$eval('#desc', e => e.getBoundingClientRect().top) < 60, 'Pack’s field stays low with the keyboard up');
assert.ok(await page.$$eval('.matchlist button', rs => rs.filter(r => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }).length) >= 3, 'fewer than three matches show above the keyboard');
await page.setViewportSize({ width: 390, height: 844 });
// and on a phone zoomed to 200% (195 px wide): suggested details read a word a line at most, not a letter, and long
// buttons wrap (WCAG 2.2 SC 1.4.10, Reflow)
await page.goto(base + '#' + await IN.encode({ partsbin: 1, batch: { id: 'ptest-zoom', source: 'details', items: [{ id: 'p-scd41', mpn: 'SCD41-D-R2', addr: '0x29', volts: '2.6–5.5 V', logic: '3.3 V' }] } }));
await page.waitForSelector('.diff');
await page.setViewportSize({ width: 195, height: 422 });
for (const hash of ['#inbox', '#bom', '#part/p-scd41', '#part/p-long', '#bin/box-long']) {
  if (hash !== '#inbox') { await page.goto(base + hash); await page.waitForTimeout(150); }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, hash + ' scrolls sideways at 200% zoom');
  if (hash === '#inbox') assert.ok(await page.evaluate(() => Math.min(...[...document.querySelectorAll('.diff .v')].map(v => v.getBoundingClientRect().width))) > 80, 'a suggested detail is squeezed at 200% zoom');
}
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(base + '#inbox'); page.once('dialog', d => d.accept()); await page.click('[data-a="drop"]'); await page.waitForSelector('text=Nothing waiting');
// at the bottom of a screen, the footer's links show above the tab bar and can be tapped
for (const hash of ['#bins', '#parts', '#settings', '#bin/bin-env']) {
  await page.goto(base + hash); await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.ok(await page.evaluate(() => { const a = document.querySelector('.jd-foot a').getBoundingClientRect(); return !!document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2)?.closest('.jd-foot'); }), hash + ': the footer is under the tab bar');
}
// small grey text, warnings, and the writing on teal buttons and labels can be read (4.5:1), in the light theme and the dark
for (const colorScheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme });
  await page.goto(base + '#bins'); await page.waitForSelector('#addbin'); await page.waitForSelector('.label.box');
  const ratios = await page.evaluate(() => {
    const lum = c => c.match(/[\d.]+/g).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const color = v => { const i = document.createElement('i'); i.style.color = `var(${v})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
    const btn = getComputedStyle(document.querySelector('.btn.primary')), box = getComputedStyle(document.querySelector('.label.box'));
    return { 'grey on the page': ratio(color('--ink3'), color('--bg')), 'grey on a card': ratio(color('--ink3'), color('--panel')), 'a warning': ratio(color('--warn'), color('--warn-soft')),
      'a teal button': ratio(btn.color, btn.backgroundColor), 'a box label': ratio(box.color, box.backgroundColor),
      'a field’s hint': ratio(getComputedStyle(document.getElementById('q'), '::placeholder').color, getComputedStyle(document.getElementById('q')).backgroundColor),
      'a green have chip': ratio(color('--ok'), color('--ok-soft')), 'the line under a picked match': (() => {
        const l = document.createElement('div'); l.className = 'matchlist'; l.innerHTML = '<button class="pick"><span><b>x</b><div class="s">#002 · Sensors</div></span></button>'; document.body.append(l);
        const r = ratio(getComputedStyle(l.querySelector('.s')).color, getComputedStyle(l.querySelector('button')).backgroundColor); l.remove(); return r; })() };
  });
  for (const [what, r] of Object.entries(ratios)) assert.ok(r >= 4.5, `${colorScheme}: ${what} is ${r.toFixed(2)}:1`);
  // a field's outline is what shows where to type, in a sheet as on the page (WCAG 2.2 SC 1.4.11, 3:1)
  const field = await page.evaluate(() => {
    const lum = c => c.match(/[\d.]+/g).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const q = getComputedStyle(document.getElementById('q')), [x, y] = [lum(q.borderTopColor), lum(q.backgroundColor)].sort((p, r) => r - p); return (x + 0.05) / (y + 0.05);
  });
  assert.ok(field >= 3, `${colorScheme}: a field's outline is ${field.toFixed(2)}:1`);
}
await page.emulateMedia({ colorScheme: 'light' });
// keyboard focus shows all round a list row (the list cut off all but its bottom edge) and on Take photo and Choose
// photo, whose file input is hidden inside the button (WCAG 2.2 SC 2.4.7)
await page.goto(base + '#parts'); await page.waitForSelector('.list .item');
await page.focus('#q');
for (let i = 0; i < 30 && !(await page.evaluate(() => document.activeElement.matches('.list .item'))); i++) await page.keyboard.press('Tab');
assert.deepEqual(await page.evaluate(() => { const c = getComputedStyle(document.activeElement); return [document.activeElement.matches('.list .item'), c.outlineStyle, parseFloat(c.outlineOffset) < 0]; }), [true, 'solid', true], 'a focused row’s ring is cut off');
await page.evaluate(() => { const r = document.createElement('div'); r.id = 'ringtest'; r.innerHTML = '<button class="btn">a</button><label class="btn" for="rt-file">Take photo<input id="rt-file" type="file" class="sr"></label>'; document.getElementById('main').prepend(r); });
await page.focus('#ringtest button'); await page.keyboard.press('Tab');
assert.equal(await page.evaluate(() => document.activeElement.id), 'rt-file');
assert.equal(await page.$eval('#ringtest label', l => getComputedStyle(l).outlineStyle), 'solid', 'Take photo shows no focus');
await page.evaluate(() => document.getElementById('ringtest').remove());

// ---- unpacking a box: the bin picked under Unpack into stays picked from bag to bag, and the page keeps its place
await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('parts-bin')), t = Date.now();
  d.items.bins['box-move'] = { code: 'BOX 02', kind: 'box', name: 'Bench', location: 'Moving boxes', t };
  for (let i = 1; i <= 16; i++) d.items.parts['p-move' + i] = { name: 'Moved part ' + String(i).padStart(2, '0'), qty: 1, unit: 'pcs', binId: 'box-move', tags: [], t };
  localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' }));
});
await page.goto(base + '#bin/box-move');
assert.equal(await page.locator('button button').count(), 0, 'a ⇢ inside a row’s own button');
assert.equal(await page.getByRole('button', { name: 'Move Moved part 01: choose a bin first', exact: true }).count(), 1, 'each ⇢ says which bag it moves');
await page.selectOption('#unpack-to', 'bin-env');
assert.equal(await page.getByRole('button', { name: 'Move Moved part 01 to ENV', exact: true }).count(), 1, 'each button says where it moves the bag');
await page.evaluate(() => window.scrollTo(0, 200));
const moveButtons = () => page.locator('button[aria-label$=" to ENV"]');
await moveButtons().first().click();
await page.waitForFunction(() => document.querySelectorAll('button[aria-label$=" to ENV"]').length === 15);
assert.equal(await page.inputValue('#unpack-to'), 'bin-env', 'the bin picked is still picked');
assert.equal(await page.evaluate(() => scrollY), 200, 'the page kept its place');
// the Drive button scrolls away with the top of the page, rather than sitting over the quantities and ⇢ buttons below it
assert.ok(await page.evaluate(() => { const r = document.getElementById('cloud-m').getBoundingClientRect(); return r.height > 0 && r.bottom <= 0; }), 'the Drive button stayed on the screen over the list');
await moveButtons().first().click();
await page.waitForFunction(() => document.querySelectorAll('button[aria-label$=" to ENV"]').length === 14);
assert.deepEqual(await page.evaluate(() => ['p-move1', 'p-move2'].map(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].binId)), ['bin-env', 'bin-env']);

// ---- a count stops at zero, from − or from the sheet
await page.goto(base + '#part/' + spareId);
assert.equal((await spare()).qty, 1);
await page.click('#dec');
await page.waitForFunction(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].qty === 0, spareId);
await page.click('#dec'); await page.waitForTimeout(200);
assert.equal((await spare()).qty, 0); assert.equal(await page.inputValue('#qv'), '0');
await page.click('#edit'); await page.fill('#p-qty', '-3'); await page.click('.sheet #save');
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.equal((await spare()).qty, 0);
// − and + on a count in metres: 1.1 m less one is 0.1 m, not 0.10000000000000009
await page.goto(base + '#part/p-heat');
await page.click('#inc'); await page.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-heat'].qty === 1.1);
await page.click('#dec'); await page.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-heat'].qty < 1);
assert.equal((await part('p-heat')).qty, 0.1); assert.equal(await page.inputValue('#qv'), '0.1');
await page.goto(base + '#part/' + spareId);

// ---- a bag number is a whole number from 1 up (a tag for "-5" would open no bag)
await page.click('#edit');
for (const v of ['-5', '0', '2.5']) {
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.fill('#p-bag', v); await page.click('.sheet #save');
  await page.waitForSelector('#toast:has-text("whole number")');
  assert.ok(await page.$('.sheet #p-bag'), 'the sheet stays open'); assert.equal((await spare()).bag, 4, 'bag ' + v + ' wasn’t saved');
}
await page.click('.sheet #cancel');

// ---- with this browser's storage full, a save is refused and says so (it used to say "Saved", and the change was gone
// after a reload): a sheet stays open with its edits, and nothing on screen shows what wasn't kept
const storageFull = on => page.evaluate(on => {
  if (!on) { Storage.prototype.setItem = window.__setItem; return; }
  window.__setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { if (k === 'parts-bin') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return window.__setItem.call(this, k, v); };
}, on);
const stored = () => page.evaluate(() => localStorage.getItem('parts-bin'));
const noToast = () => page.evaluate(() => { document.getElementById('toast').hidden = true; });
const FULL = '#toast:has-text("This browser’s storage is full, so that wasn’t saved.")';
await page.goto(base + '#part/p-scd41'); await page.waitForSelector('#edit');
await storageFull(true);
const kept = await stored(), { qty: scdQty, notes: scdNotes } = await part('p-scd41');
await noToast(); await page.click('#edit'); await page.fill('#p-notes', 'A note there’s no room for'); await page.click('.sheet #save');
await page.waitForSelector(FULL); await page.waitForTimeout(300);
assert.equal(await page.textContent('#toast'), 'This browser’s storage is full, so that wasn’t saved.', 'it said Saved after all'); // nothing in the Inbox to dismiss
assert.equal(await page.inputValue('.sheet #p-notes'), 'A note there’s no room for', 'the sheet stays open with the edit');
// deleting is a save too (the part is kept, marked deleted, so other devices hear of it)
await noToast(); page.once('dialog', d => d.accept()); await page.click('.sheet #del');
await page.waitForSelector(FULL); assert.ok(await page.$('.sheet #p-name'), 'the sheet stays open after a refused delete');
await page.click('.sheet #cancel');
// + on the count goes back to what's kept
await noToast(); await page.click('#inc'); await page.waitForSelector(FULL);
assert.equal(await page.inputValue('#qv'), String(scdQty));
// Save this BOM
await page.goto(base + '#bom'); await page.waitForSelector('#savebom');
await noToast(); await page.click('#savebom'); await page.fill('.sheet #b-name', 'No room'); await page.click('.sheet #save'); await page.waitForSelector(FULL);
assert.equal(await page.inputValue('.sheet #b-name'), 'No room', 'the name sheet stays open'); await page.click('.sheet #cancel');
// suggestions from the Inbox stay waiting until they can be saved
await page.goto(base + '#inbox');
await page.fill('#inb-paste', await IN.encode({ partsbin: 1, batch: { id: 'ptest-full', source: 'details', items: [{ id: 'p-bme280', volts: '1.71–3.6 V' }] } }));
await page.click('#inb-go'); await page.waitForSelector('[data-a="apply"]');
await noToast(); await page.click('[data-a="apply"]'); await page.waitForSelector(FULL);
assert.match(await page.textContent('#toast'), / Dismiss what’s waiting in the Inbox to make room\.$/, 'it says what makes room (deleting can’t)');
assert.equal(await page.locator('.card.inb').count(), 1, 'the suggestion is still waiting');
assert.equal(await stored(), kept, 'nothing was written');
await storageFull(false);
page.once('dialog', d => d.accept()); await page.click('[data-a="drop"]'); await page.waitForSelector('text=Nothing waiting');
// a batch the Inbox can't store isn't shown as taken (it showed, said "2 from Claude to check", and was gone after a
// reload with its link already wiped from the address): it says so, and the link stays to try again
const fullLink = base + '#' + await IN.encode({ partsbin: 1, batch: { id: 'ptest-inbox-full', source: 'photo', items: [{ name: 'Rotary encoder', qty: 4 }, { name: 'Piezo buzzer', qty: 2 }] } });
await fullFor(page, 'parts-bin.inbox', true);
await noToast(); await page.goto(fullLink);
await page.waitForSelector('#toast:has-text("This browser’s storage is full, so that batch wasn’t kept.")');
await page.waitForSelector('#main h2:has-text("Inbox")');
assert.equal(await page.locator('.card.inb').count(), 0); assert.equal(await page.locator('#tabbar .badge').count(), 0);
assert.ok((await page.evaluate(() => location.hash)).startsWith('#' + IN.PREFIX), 'the link is still in the address');
await fullFor(page, 'parts-bin.inbox', false);
await page.reload(); await page.waitForSelector('.card.inb');
assert.equal(await page.locator('.card.inb').count(), 2); assert.equal(await page.evaluate(() => location.hash), '#inbox');
// a card skipped while the Inbox can't be written says it may come back
await fullFor(page, 'parts-bin.inbox', true);
await noToast(); await page.click('.card.inb[data-k="i0"] [data-a="skip"]');
await page.waitForSelector('#toast:has-text("may show again after a reload")');
await fullFor(page, 'parts-bin.inbox', false);
page.once('dialog', d => d.accept()); await page.click('[data-a="drop"]'); await page.waitForSelector('text=Nothing waiting');
await page.goto(base + '#part/p-scd41'); await page.reload(); await page.waitForSelector('h2:has-text("SCD41")');
assert.equal((await part('p-scd41')).notes, scdNotes);
assert.equal((await part('p-scd41')).qty, scdQty);
assert.ok(!Object.values(JSON.parse(await stored()).items.projects).some(p => p.name === 'No room'));

// ---- the phone's Back closes a sheet and leaves the page as it was, as an Android app does (it used to go back a page
// underneath, with the sheet still open over it)
const at = h => page.waitForFunction(h => location.hash === h, h);
const shut = p => p.waitForFunction(() => !document.querySelector('.sheet') && !history.state?.sheet); // closed, and off its step
await page.goto(base + '#bins'); await page.goto(base + '#bin/bin-env'); await page.goto(base + '#part/p-bme280');
await page.click('#edit'); await page.waitForSelector('.sheet #p-name');
await page.goBack(); await shut(page);
assert.equal(await page.evaluate(() => location.hash), '#part/p-bme280', 'Back went to another page');
assert.equal(await page.textContent('.binhead h2'), 'BME280 (Adafruit)');
assert.equal(await page.evaluate(() => document.querySelector('.app').inert), false, 'the page behind the sheet can be used again');
await page.goBack(); await at('#bin/bin-env');
assert.equal(await page.locator('.sheet').count(), 0);
// closed by Cancel, Escape or a tap outside, a sheet takes its step with it: the next Back leaves the page, and so does ←
for (const how of ['Cancel', 'Escape', 'a tap outside', '←']) {
  await page.goto(base + '#bin/bin-env'); await page.goto(base + '#part/p-bme280');
  await page.click('#edit'); await page.waitForSelector('.sheet #p-name');
  if (how === 'Escape') await page.keyboard.press('Escape'); else if (how === 'a tap outside') await page.mouse.click(5, 5); else await page.click('.sheet #cancel');
  await shut(page);
  if (how === '←') await page.click('#back'); else await page.goBack();
  await at('#bin/bin-env');
}
// Save, then the tag sheet: one step for the two, and Back stops the write waiting for the sticker
await page.goto(base + '#part/p-bme280'); await page.click('#edit'); await page.check('#p-dotag'); await page.click('.sheet #save');
await page.waitForSelector('#tz.wait');
await page.goBack(); await shut(page);
assert.equal(await page.evaluate(() => location.hash), '#part/p-bme280');
assert.equal(await page.evaluate(() => window.__tap()), false, 'the write was still waiting after Back');
await page.goBack(); await at('#bin/bin-env');
// a new bag's tag sheet closed by Back, Escape or a tap outside stops waiting for the sticker and takes no number
await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts['p-back'] = { name: 'Back test', qty: 1, t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
await page.goto(base + '#part/p-back');
for (const how of ['Back', 'Escape', 'a tap outside']) {
  await page.click('#bagtag'); await page.click('.sheet #write'); await page.waitForSelector('#tz.wait');
  if (how === 'Back') await page.goBack(); else if (how === 'Escape') await page.keyboard.press('Escape'); else await page.mouse.click(5, 5);
  await shut(page);
  assert.equal(await page.evaluate(() => location.hash), '#part/p-back', how);
  assert.equal(await page.evaluate(() => window.__tap()), false, `${how}: the write was still waiting`);
  assert.ok(!(await part('p-back')).bag, `${how}: the bag number was taken`);
}
// reloaded with a sheet open (as a phone does with a tab it put away), one Back still leaves the page
await page.goto(base + '#bin/bin-env'); await page.goto(base + '#part/p-bme280'); await page.click('#edit'); await page.waitForSelector('.sheet #p-name');
await page.reload(); await page.waitForSelector('#edit'); await shut(page);
await page.goBack(); await at('#bin/bin-env');
// a part opened in a tab of its own (as a tag does when Parts Bin is closed): after a sheet, its ← goes to Parts
const [solo] = await Promise.all([ctx.waitForEvent('page'), page.evaluate(u => { window.open(u); }, base + '#part/p-scd41')]);
await solo.waitForSelector('#edit');
await solo.click('#edit'); await solo.click('.sheet #cancel'); await shut(solo);
await solo.click('#back'); await solo.waitForFunction(() => location.hash === '#parts');
await solo.close();
// a step back off a closed sheet that never lands (nothing behind it) doesn't hold up opening anything else for long
await page.goto(base + '#part/p-bme280'); await page.evaluate(() => { window.__back = History.prototype.back; History.prototype.back = () => {}; });
await page.click('#edit'); await page.click('.sheet #cancel'); await page.waitForTimeout(2100);
await page.click('#tabbar [data-go="parts"]'); await at('#parts');
await page.evaluate(() => { History.prototype.back = window.__back; });
// a new bin opens its page, and Back from there goes to the page the sheet was on
await page.goto(base + '#bins'); await page.click('#addbin'); await page.fill('#f-code', 'BACK'); await page.click('.sheet #save');
await page.waitForFunction(() => location.hash.startsWith('#bin/') && !document.querySelector('.sheet'));
await page.goBack(); await at('#bins');
await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')), t = Date.now() + 1000; d.items.parts['p-back'].del = t; for (const b of Object.values(d.items.bins)) if (b.code === 'BACK') b.del = t; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });

// ---- a change made in another tab draws the screen again, keeping what's being typed and where the keyboard is (it used to
// empty Pack's description and its matches and the API key being typed, and leave the keyboard nowhere)
const tabB = await ctx.newPage();
await tabB.goto(base + '#part/p-bme280'); await tabB.waitForSelector('#inc');
const bump = async () => { const q = (await part('p-bme280')).qty; await tabB.click('#inc'); await page.waitForFunction(q => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-bme280'].qty === q + 1, q); return q + 1; };
const mark = sel => page.evaluate(sel => { document.querySelector(sel).firstElementChild.dataset.was = '1'; }, sel);
const redrawn = sel => page.waitForFunction(sel => !document.querySelector(sel).querySelector(':scope > [data-was]'), sel);
const keyboard = () => page.evaluate(() => { const a = document.activeElement; return [a.id, a.selectionStart, a.selectionEnd]; });
// Pack: the description, its matches (showing the new count) and the caret
await page.goto(base + '#scan'); await page.fill('#desc', 'bme'); await page.waitForSelector('.matchlist [data-id="p-bme280"]');
await page.evaluate(() => document.getElementById('desc').setSelectionRange(1, 2));
await mark('#main'); let bmeQty = await bump(); await redrawn('#main');
assert.equal(await page.inputValue('#desc'), 'bme');
await page.waitForSelector(`.matchlist [data-id="p-bme280"]:has-text("in stock ${bmeQty}")`);
assert.deepEqual(await keyboard(), ['desc', 1, 2]);
// a count that isn't being typed shows the new one
await page.goto(base + '#part/p-bme280'); await page.waitForSelector('#qv');
await mark('#main'); bmeQty = await bump(); await redrawn('#main');
assert.equal(await page.inputValue('#qv'), String(bmeQty));
// a sheet open over the screen as it's drawn again still hands the keyboard back to the button that opened it
await page.focus('#edit'); await page.keyboard.press('Enter'); await page.waitForSelector('.sheet #p-name');
await mark('#main'); bmeQty = await bump(); await redrawn('#main');
await page.keyboard.press('Escape'); await shut(page);
assert.equal(await page.evaluate(() => document.activeElement.id), 'edit');
// Settings shows none of the inventory, so it isn't drawn again at all: the API key and model being typed stay as they are
await page.goto(base + '#settings'); await page.fill('#ai-key', 'sk-ant-typed-not-saved'); await page.fill('#ai-model', 'claude-typed');
await page.evaluate(() => document.getElementById('ai-model').setSelectionRange(3, 3));
await mark('#tabbar'); await bump(); await redrawn('#tabbar'); // the counts beside it are
assert.equal(await page.inputValue('#ai-key'), 'sk-ant-typed-not-saved'); assert.equal(await page.inputValue('#ai-model'), 'claude-typed');
assert.deepEqual(await keyboard(), ['ai-model', 3, 3]);
// and Save shows what was kept (trimmed, and the usual model for none), Remove key an empty box
await page.fill('#ai-key', '  sk-ant-not-a-real-key  '); await page.fill('#ai-model', ''); await page.click('#ai-save');
await page.waitForSelector('#ai-clear');
assert.equal(await page.inputValue('#ai-key'), 'sk-ant-not-a-real-key'); assert.equal(await page.inputValue('#ai-model'), (await import('../js/ai.js')).DEFAULT_MODEL);
await page.click('#ai-clear'); await page.waitForFunction(() => !document.querySelector('#ai-clear'));
assert.equal(await page.inputValue('#ai-key'), '');
await tabB.close();

// ---- an API key the API refuses (a stand-in for the API, and no real key): it says so, and the part can be typed in
const aiCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
// apiSays: what the stand-in answers next (null: the key is refused); apiAsked: what it was sent
let apiSays = null, apiAsked = null;
await aiCtx.route('https://api.anthropic.com/**', r => (r.request().method() === 'OPTIONS'
  ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } })
  : (apiAsked = r.request().postDataJSON(), apiSays)
    ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: apiAsked.model, ...apiSays }) })
    : r.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) })));
const ai = await aiCtx.newPage();
await ai.goto(base + '#settings');
await ai.fill('#ai-key', 'sk-ant-not-a-real-key'); await ai.click('#ai-save');
await ai.goto(base + '#scan'); await ai.fill('#desc', 'BME280'); await ai.click('#identify');
await ai.waitForSelector('.sheet #p-name');
assert.equal(await ai.textContent('#status'), 'The API key was refused. Check it in Settings.');
assert.equal(await ai.inputValue('#p-name'), 'BME280', 'the part can still be typed in by hand');
await ai.click('.sheet #cancel');
await ai.goto(base + '#bom'); await ai.fill('#bom', '1 SCD41'); await ai.click('#smart');
await ai.waitForSelector('#toast:has-text("The API key was refused")');
await ai.waitForSelector('.bom-summary');
// the API answering: Identify fills in the part. There's room for the model's thinking as well as the answer (it thinks
// first, and that counts against max_tokens, which was 1,500), and no effort is sent, which some models refuse.
const identified = { matchId: null, matchConfidence: 0, name: 'Bosch BME280 breakout', category: 'Sensors', mpn: 'BME280', qty: 3, unit: 'pcs', tags: ['i2c'], notes: 'Temperature, humidity, pressure' };
apiSays = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(identified) }] };
await ai.goto(base + '#scan'); await ai.fill('#desc', 'BME280'); await ai.click('#identify');
await ai.waitForSelector('#status:has-text("New: Bosch BME280 breakout")');
assert.equal(apiAsked.max_tokens, 16000); assert.equal(apiAsked.output_config, undefined);
await ai.click('.matchlist [data-id=""]'); await ai.waitForSelector('.sheet #p-name');
assert.deepEqual([await ai.inputValue('#p-name'), await ai.inputValue('#p-cat'), await ai.inputValue('#p-mpn'), await ai.inputValue('#p-qty')], ['Bosch BME280 breakout', 'Sensors', 'BME280', '3']);
await ai.click('.sheet #cancel');
// an answer cut off at max_tokens says so, rather than "Could not identify", and the part can still be typed in
apiSays = { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: '{"matchId": null, "name": "Bosch BME' }] };
await ai.goto(base + '#scan'); await ai.fill('#desc', 'BME280'); await ai.click('#identify');
await ai.waitForSelector('.sheet #p-name');
assert.equal(await ai.textContent('#status'), 'The answer was cut off. Try again, or fill it in by hand.');
assert.equal(await ai.inputValue('#p-name'), 'BME280');
await ai.click('.sheet #cancel');
// and one Claude declines says that, in BOM check's Smarter matching too
apiSays = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null }, content: [] };
await ai.goto(base + '#bom'); await ai.fill('#bom', '1 SCD41'); await ai.click('#smart');
await ai.waitForSelector('#toast:has-text("Claude declined that one. Used plain matching.")');
await ai.waitForSelector('.bom-summary');
// with nothing in the inventory yet: Parts points at Pack (it used to be "Scan in"), and the Inbox doesn't say every part
// has details
await ai.goto(base + '#parts'); assert.match(await ai.textContent('#main .empty'), /^No parts here yet\. Add one, or use Pack/);
await ai.goto(base + '#inbox'); await ai.waitForSelector('text=Fill in details');
assert.equal(await ai.locator('text=Every part has some details already').count(), 0);
await aiCtx.close();

// ---- Smarter matching and photo identification with the stand-in API: Claude's "nothing in the inventory is this"
// stands (the plain matcher's guess was shown instead, as a sure match), a second tap while waiting sends no second
// request, an answer that can't be read says so (it fell back without a word), and a long list gets more room to answer
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: {}, parts: {
    'p-scd41': { name: 'SCD41', category: 'Sensors', qty: 3, unit: 'pcs', tags: [], t: 1 },
    'p-bme': { name: 'BME280 (Adafruit)', category: 'Sensors', qty: 5, unit: 'pcs', tags: [], t: 1 } } } });
  const sCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await sCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) { localStorage.setItem('parts-bin', d); localStorage.setItem('parts-bin.ai', JSON.stringify({ key: 'sk-ant-not-a-real-key', model: '' })); } }, seed);
  // says: the answer's text; hold: a promise the answer waits for; asked: every request
  let says = '', hold = null; const asked = [];
  await sCtx.route('https://api.anthropic.com/**', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    const body = r.request().postDataJSON(); asked.push(body);
    if (hold) await hold;
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: says }] }) });
  });
  const sp = await sCtx.newPage();
  sp.problems = []; sp.on('pageerror', e => sp.problems.push(e.message));
  await sp.goto(base + '#bom'); await sp.waitForSelector('#smart');
  // "BME280 breakout" plainly matches the BME280 (Adafruit); Claude says nothing here is one, and the line shows as missing
  says = JSON.stringify([{ line: 0, id: null, confidence: 0.9 }, { line: 1, id: 'p-scd41', confidence: 0.95 }]);
  let release; hold = new Promise(f => { release = f; });
  await sp.fill('#bom', '1 BME280 breakout\n2 CO2 sensor');
  await sp.click('#smart');
  await sp.waitForFunction(() => document.querySelector('#smart').disabled, null, { timeout: 3000 });
  await sp.locator('#smart').click({ force: true }).catch(() => {}); await sp.locator('#smart').dispatchEvent('click');
  release(); hold = null;
  await sp.waitForSelector('.bom-summary');
  assert.equal(asked.length, 1, 'a second tap while waiting sent no second request');
  assert.equal(await sp.isDisabled('#smart'), false, 'on again once the answer is in');
  assert.equal(await sp.locator('.bom-table tbody tr').nth(0).getAttribute('data-st'), 'missing', 'Claude’s no match is kept');
  assert.equal(await sp.locator('.bom-table tbody tr').nth(1).getAttribute('data-st'), 'have');
  assert.equal(asked[0].max_tokens, 16000);
  // an answer that numbers its lines from 1 is read that way, not each line taking the answer for the one before it
  says = JSON.stringify([{ line: 1, id: null, confidence: 0.9 }, { line: 2, id: 'p-scd41', confidence: 0.95 }]);
  await sp.click('#smart'); await sp.waitForFunction(() => !document.querySelector('#smart').disabled); await sp.waitForSelector('.bom-summary');
  assert.deepEqual(await sp.locator('.bom-table tbody tr').evaluateAll(rs => rs.map(r => r.dataset.st)), ['missing', 'have'], 'lines counted from 1');
  // an answer that isn't the list asked for says so, and plain matching is used
  says = 'I could not work that out.';
  await sp.click('#smart');
  await sp.waitForSelector('#toast:has-text("Claude’s answer couldn’t be read. Used plain matching.")');
  await sp.waitForSelector('.bom-summary');
  assert.equal(await sp.locator('.bom-table tbody tr').nth(0).getAttribute('data-st'), 'have', 'plain matching');
  assert.equal(await sp.locator('.bom-table tbody tr').nth(1).getAttribute('data-st'), 'missing', 'plain matching');
  // a long list asks for more room (16,000 was fixed, whatever the length)
  says = '[]';
  await sp.fill('#bom', Array.from({ length: 300 }, (_, i) => `1 Part number ${i + 1}`).join('\n'));
  await sp.click('#smart'); await sp.waitForSelector('.bom-summary');
  assert.equal(asked.at(-1).max_tokens, 16000 + 200 * 40);
  // Identify: off while it waits, and an unreadable answer says so, with the part to type in
  await sp.goto(base + '#scan'); await sp.waitForSelector('#identify');
  says = 'Looks like a sensor of some kind.'; hold = new Promise(f => { release = f; });
  const n = asked.length;
  await sp.fill('#desc', 'BME280'); await sp.click('#identify');
  await sp.waitForFunction(() => document.querySelector('#identify').disabled, null, { timeout: 3000 });
  await sp.locator('#identify').dispatchEvent('click');
  release(); hold = null;
  await sp.waitForSelector('.sheet #p-name');
  assert.equal(asked.length, n + 1, 'one request');
  assert.equal(await sp.textContent('#status'), 'The answer couldn’t be read. Try again, or fill it in by hand.');
  assert.equal(await sp.inputValue('#p-name'), 'BME280');
  await sp.click('.sheet #cancel');
  assert.equal(await sp.isDisabled('#identify'), false);
  assert.deepEqual(sp.problems, []);
  await sCtx.close();
}

// ---- your own photo of a part: identifying a photo in Pack cuts a small picture of each part on it from the box Claude
// gives round it, and a part saved from it with no reference photo keeps that picture, in this browser only (not in the
// inventory, so not in Drive or a backup). A part with no box gets no picture rather than the whole bench; a part with a
// reference photo shows that instead. A part's page has Use my photo and Remove my photo.
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: {}, parts: {
    'p-bme': { name: 'BME280 (Adafruit)', category: 'Sensors', qty: 5, unit: 'pcs', tags: [], t: 1 },
    'p-ref': { name: 'SSD1306 OLED', category: 'Displays', qty: 2, unit: 'pcs', tags: [], img: 'https://img.test/oled.png', t: 1 },
    'p-gone': { name: 'HC-SR04', category: 'Sensors', qty: 1, unit: 'pcs', tags: [], img: 'https://img.test/missing.png', t: 1 } } } });
  const fCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await fCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) { localStorage.setItem('parts-bin', d); localStorage.setItem('parts-bin.ai', JSON.stringify({ key: 'sk-ant-not-a-real-key', model: '' })); } }, seed);
  await fCtx.route('https://img.test/**', async r => (r.request().url().includes('missing') ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ contentType: 'image/png', body: await readFile(join(root, 'icon-192.png')) })));
  let says = null, asked = null;
  await fCtx.route('https://api.anthropic.com/**', async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    asked = r.request().postDataJSON();
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: asked.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(says) }] }) });
  });
  const fp = await fCtx.newPage();
  fp.problems = []; fp.on('pageerror', e => fp.problems.push(e.message)); fp.on('console', m => { if (m.type() === 'error' && !m.location().url.startsWith('https://img.test/')) fp.problems.push(m.text()); });
  await fp.goto(base + '#scan'); await fp.waitForSelector('#file', { state: 'attached' });
  // a bench photo: a red board on the left, a blue one on the right, on grey
  const bench = Buffer.from(await fp.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 400; const g = c.getContext('2d');
    g.fillStyle = '#888'; g.fillRect(0, 0, 800, 400); g.fillStyle = '#d00'; g.fillRect(60, 60, 260, 280); g.fillStyle = '#00d'; g.fillRect(480, 60, 260, 280);
    return c.toDataURL('image/png').split(',')[1]; }), 'base64');
  says = { items: [
    { matchId: null, matchConfidence: 0, name: 'Red driver board', category: 'Modules', mpn: '', qty: 1, unit: 'pcs', tags: [], notes: '', box: [0.075, 0.15, 0.4, 0.85] },
    { matchId: 'p-bme', matchConfidence: 0.9, name: 'BME280 breakout', category: 'Sensors', mpn: 'BME280', qty: 2, unit: 'pcs', tags: [], notes: '', box: [0.6, 0.15, 0.925, 0.85] },
    { matchId: null, matchConfidence: 0, name: 'Mystery cable', category: 'Cables', mpn: '', qty: 1, unit: 'pcs', tags: [], notes: '', box: null }] };
  await fp.setInputFiles('#file', { name: 'bench.png', mimeType: 'image/png', buffer: bench });
  await fp.waitForSelector('#status:has-text("3 parts in this photo")');
  assert.match(asked.messages[0].content.at(-1).text, /"box": \[left, top, right, bottom\]/, 'a box is asked for each part');
  assert.deepEqual(await fp.locator('.shotstrip button').evaluateAll(bs => bs.map(b => [b.textContent, !!b.querySelector('img'), b.getAttribute('aria-pressed')])),
    [['Red driver board', true, 'true'], ['BME280 breakout', true, 'false'], ['Mystery cable', false, 'false']]);
  // each picture is cut from its own box, with a margin: the red one is red, the blue one blue
  const colour = sel => fp.locator(sel).evaluate(async img => { await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(c.width / 2 - 5, c.height / 2 - 5, 10, 10).data; const e = g.getImageData(1, 1, 1, 1).data; return { mid: [d[0], d[1], d[2]].map(v => v > 128), edge: [e[0], e[1], e[2]].map(v => Math.abs(v - 136) < 30), w: c.width, h: c.height }; });
  const red = await colour('.shotstrip button:nth-child(1) img'), blue = await colour('.shotstrip button:nth-child(2) img');
  assert.deepEqual(red.mid, [true, false, false]); assert.deepEqual(blue.mid, [false, false, true]);
  assert.deepEqual(red.edge, [true, true, true], 'a margin of the bench round it');
  assert.ok(Math.max(red.w, red.h) <= 256 && red.h > red.w, `small, and the shape of the board (${red.w}×${red.h})`);
  assert.equal(await fp.locator('.shotmine img').count(), 1, 'the picture of the one picked is shown with what it is for');
  // the red board is saved as a new part with its picture; the photo's other two stay
  await fp.click('.matchlist [data-id=""]'); await fp.waitForSelector('.sheet #p-name');
  assert.equal(await fp.inputValue('#p-name'), 'Red driver board');
  await fp.click('.sheet #save'); await fp.waitForFunction(() => !document.querySelector('.sheet'));
  await fp.waitForSelector('#status:has-text("2 parts in this photo")');
  assert.deepEqual(await fp.locator('.shotstrip button').allTextContents(), ['BME280 breakout', 'Mystery cable']);
  // the BME280 is matched to the part already listed, which has no reference photo: it takes its picture
  await fp.click('.matchlist .pick'); await fp.waitForSelector('.sheet #p-name');
  await fp.click('.sheet #save'); await fp.waitForFunction(() => !document.querySelector('.sheet'));
  await fp.waitForSelector('#status:has-text("New: Mystery cable")');
  assert.equal(await fp.locator('.shotstrip').count(), 0); assert.equal(await fp.locator('.shotmine').count(), 0, 'no box, no picture');
  await fp.click('.matchlist [data-id=""]'); await fp.waitForSelector('.sheet #p-name'); await fp.click('.sheet #save'); await fp.waitForFunction(() => !document.querySelector('.sheet'));
  await fp.waitForFunction(() => !document.querySelector('.matchlist') && !document.querySelector('#status').textContent, null, { timeout: 3000 });
  // a photo of the SSD1306, which has a reference photo: that stays its picture, and no picture is kept for it
  says = { items: [{ matchId: 'p-ref', matchConfidence: 0.9, name: 'SSD1306', category: 'Displays', qty: 1, unit: 'pcs', box: [0.6, 0.15, 0.925, 0.85] }] };
  await fp.setInputFiles('#file', { name: 'oled.png', mimeType: 'image/png', buffer: bench });
  await fp.waitForSelector('#status:has-text("Looks like: SSD1306 OLED")');
  await fp.click('.matchlist .pick'); await fp.waitForSelector('.sheet #p-name'); await fp.click('.sheet #save'); await fp.waitForFunction(() => !document.querySelector('.sheet'));
  const kept = () => fp.evaluate(() => new Promise(res => { const r = indexedDB.open('parts-bin.photos'); r.onsuccess = () => { const q = r.result.transaction('photos').objectStore('photos').getAllKeys(); q.onsuccess = () => res(q.result.sort()); }; }));
  const doc = await fp.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')));
  const redId = Object.entries(doc.items.parts).find(([, x]) => x.name === 'Red driver board')[0], cableId = Object.entries(doc.items.parts).find(([, x]) => x.name === 'Mystery cable')[0];
  assert.deepEqual(await kept(), [redId, 'p-bme'].sort(), 'pictures for the red board and the BME280 only');
  assert.ok(!JSON.stringify(doc).includes('data:image'), 'no picture in the inventory, so none in Drive or a backup');
  // a part's page shows its picture where a reference photo would be, marked as yours, and enlarges it
  await fp.goto(base + '#part/' + redId); await fp.waitForSelector('.binhead .photo.minephoto img.mine');
  assert.equal(await fp.locator('.binhead .photo').getAttribute('aria-label'), 'Your photo, tap to enlarge');
  await fp.click('.binhead .photo'); await fp.waitForSelector('.sheet .refbig.mine img'); await fp.click('.sheet #done');
  assert.equal(await fp.locator('#myphoto-file').count(), 1); assert.equal(await fp.locator('#rmphoto').count(), 1);
  // the SSD1306 shows its reference photo and offers no photo of yours
  await fp.goto(base + '#part/p-ref'); await fp.waitForSelector('.binhead .photo.refphoto img.ref');
  assert.equal(await fp.locator('#myphoto').count(), 0);
  // the cable has none: Use my photo puts one on (the whole picture chosen), Remove my photo takes it off, with Undo
  await fp.goto(base + '#part/' + cableId); await fp.waitForSelector('#myphoto-file', { state: 'attached' });
  assert.equal(await fp.locator('.binhead .photo img').count(), 0); assert.equal(await fp.locator('#rmphoto').count(), 0);
  await fp.setInputFiles('#myphoto-file', { name: 'cable.png', mimeType: 'image/png', buffer: bench });
  await fp.waitForSelector('#toast:has-text("Your photo is on Mystery cable")'); await fp.waitForSelector('.binhead .photo.minephoto img.mine');
  const whole = await colour('.binhead .photo img.mine'); assert.deepEqual([whole.w, whole.h], [256, 128], 'the whole picture, 256 px on its long side');
  await fp.click('#rmphoto'); await fp.waitForSelector('#toast:has-text("Removed your photo")');
  assert.equal(await fp.locator('.binhead .photo img').count(), 0);
  await fp.click('#toast button'); await fp.waitForSelector('.binhead .photo.minephoto img.mine');
  // a part whose reference photo has gone shows yours instead
  await fp.evaluate(src => new Promise(res => { const r = indexedDB.open('parts-bin.photos'); r.onsuccess = () => { const t = r.result.transaction('photos', 'readwrite'); t.objectStore('photos').put({ src, t: 1 }, 'p-gone'); t.oncomplete = res; }; }), await fp.locator('.binhead .photo img.mine').getAttribute('src'));
  await fp.goto(base + '#part/p-gone'); await fp.reload();
  await fp.waitForSelector('.binhead .photo.minephoto img.mine');
  assert.equal(await fp.locator('.binhead .photo img.ref').count(), 0);
  // a reload keeps them (and a part with one still reads as having no details, for Claude to fill in)
  await fp.goto(base + '#part/p-bme'); await fp.reload(); await fp.waitForSelector('.binhead .photo.minephoto img.mine');
  // a photo of one part, then something else typed in and saved: the photo and what it was taken for don't come back
  says = { items: [{ matchId: null, name: 'L298N motor driver', category: 'Modules', qty: 1, box: [0.075, 0.15, 0.4, 0.85] }] };
  await fp.goto(base + '#scan'); await fp.waitForSelector('#file', { state: 'attached' });
  await fp.setInputFiles('#file', { name: 'one.png', mimeType: 'image/png', buffer: bench });
  await fp.waitForSelector('#status:has-text("New: L298N motor driver")');
  await fp.fill('#desc', 'Mini breadboard'); await fp.click('.matchlist [data-id=""]:has-text("Mini breadboard")');
  await fp.waitForSelector('.sheet #p-name'); assert.equal(await fp.inputValue('#p-name'), 'Mini breadboard');
  await fp.click('.sheet #save'); await fp.waitForFunction(() => !document.querySelector('.sheet'));
  await fp.waitForSelector('.packed :text("Mini breadboard")');
  assert.equal(await fp.locator('#result img.preview').count(), 0, 'the photo is put away');
  assert.equal(await fp.textContent('#status'), '');
  assert.equal(await fp.locator('.matchlist').count(), 0);
  assert.deepEqual(fp.problems, []);
  await fCtx.close();
}

// ---- in a browser that can't write tags, a bag's tag sheet says tags need Chrome on Android and offers the link to copy.
// (It used to offer Tag Along, which needs NFC too and didn't read the link it was given, and opening it took the number.)
const noNfcCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await noNfcCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, JSON.stringify({ app: 'parts-bin', v: 1, items: { bins: {}, parts: { 'p-loose': { name: 'Loose part', qty: 1, t: 1 } }, projects: {} } }));
await noNfcCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const noNfc = await noNfcCtx.newPage();
await noNfc.goto(base + '#part/p-loose');
assert.equal(await noNfc.evaluate(() => 'NDEFReader' in window), false);
await noNfc.click('#bagtag');
await noNfc.waitForSelector('.sheet #copy');
assert.equal(await noNfc.locator('.sheet a').count(), 0, 'a link out of the tag sheet');
assert.equal(await noNfc.textContent('.sheet #t-status'), 'Tags need Chrome on Android. Open Parts Bin there to write this one, or copy its link.');
assert.match(await noNfc.textContent('.sheet p.muted'), /The number is saved once its link is copied/);
const looseBag = () => noNfc.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-loose'].bag);
await noNfc.click('.sheet #done'); assert.ok(!(await looseBag()), 'looking at the sheet took no number');
await noNfc.click('#bagtag'); await noNfc.click('.sheet #copy');
await noNfc.waitForSelector('#toast:has-text("Link copied")');
assert.equal(await noNfc.evaluate(() => navigator.clipboard.readText()), base + '#bag/001');
assert.equal(await looseBag(), 1, 'copying the link took the number');
await noNfcCtx.close();

// ---- a backup saved late in the evening is named for that day, not the next one (as it is in UTC)
const tzCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York', acceptDownloads: true });
const tz = await tzCtx.newPage();
await tz.goto(base + '#settings');
await tz.clock.setFixedTime(new Date('2026-10-14T02:30:00Z')); // 22:30 on 13 October in New York
const [backup] = await Promise.all([tz.waitForEvent('download'), tz.click('#exp')]);
assert.equal(backup.suggestedFilename(), 'parts-bin-2026-10-13.json');
// and it says so, by name: a phone's download can go by unseen
await tz.waitForSelector('#toast:has-text("Backup saved: parts-bin-2026-10-13.json")');
await tzCtx.close();

// ---- every control has a name a screen reader can say, a sheet is named by its heading, and toasts are announced
const named = async (hash, role, name) => { await page.goto(base + hash); assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1, `${hash}: a ${role} called "${name}"`); };
await named('#parts', 'searchbox', 'Search'); await named('#parts', 'combobox', 'Show');
await named('#bin/box-move', 'combobox', 'Unpack into'); await named('#bom', 'combobox', 'Saved BOMs');
await named('#scan', 'combobox', 'Packing into'); await named('#part/p-scd41', 'spinbutton', 'Quantity');
// the + buttons say what they add (they were read as "Bin", "Part", "Box"), and icons beside words aren't read as images
await named('#bins', 'button', 'New bin'); await named('#parts', 'button', 'New part'); await named('#bin/bin-env', 'button', 'New part');
await named('#scan', 'button', 'New bin'); await named('#scan', 'button', 'New box');
assert.equal(await page.locator('svg:not([aria-hidden="true"])').count(), 0, 'an icon read as an image');
await page.goto(base + '#part/p-scd41');
await page.click('#edit');
assert.equal(await page.getByRole('dialog', { name: 'Edit part' }).count(), 1);
await page.click('.sheet #save');
await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === 'Saved');
// a sheet keeps the keyboard while it's open, and hands it back to the button that opened it
await page.focus('#edit'); await page.keyboard.press('Enter'); await page.waitForSelector('.sheet #save');
await page.focus('.sheet #save'); await page.keyboard.press('Tab');
assert.ok(await page.evaluate(() => !document.activeElement.closest('.app, #tabbar, .jd-foot, .mobile-cloud')), 'Tab went behind the sheet');
await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.equal(await page.evaluate(() => document.activeElement.id), 'edit', 'the keyboard is back on Edit');

// ---- a file with a change time no date can hold loads, and the inventory still shows (it used to vanish)
const farFile = join(tmp, 'far.json');
await writeFile(farFile, JSON.stringify({ app: 'parts-bin', v: 1, items: { parts: { 'p-far': { name: 'From the far future', qty: 1, t: 9e15 } } } }));
await page.goto(base + '#settings');
const [chooser3] = await Promise.all([page.waitForEvent('filechooser'), page.click('#imp')]);
await chooser3.setFiles(farFile);
await page.waitForSelector('text=Loaded: 1 item');
await page.goto(base + '#parts'); await page.reload();
await page.waitForSelector('.item:has-text("BME280 (Adafruit)")'); await page.waitForSelector('.item:has-text("From the far future")');

// ---- the buttons tapped over and over while counting and unpacking are big enough for a thumb (44 px)
const big = async sel => { const b = await page.locator(sel).first().boundingBox(); assert.ok(b.width >= 44 && b.height >= 44, `${sel} is ${b.width}×${b.height}`); };
await page.goto(base + '#part/p-bme280'); await big('#dec'); await big('#inc');
await page.goto(base + '#bin/box-move'); await big('.unpack > .btn');

// ---- a box's printed packing list says Parts Bin, and the site's footer and Drive button stay off the paper
await page.evaluate(() => { window.print = () => {}; });
await page.click('#print');
assert.match(await page.textContent('#print-root .sub'), / · Parts Bin, /);
await page.emulateMedia({ media: 'print' });
assert.deepEqual(await page.evaluate(() => ['.app', '.jd-foot', '.mobile-cloud'].map(s => getComputedStyle(document.querySelector(s)).display)), ['none', 'none', 'none']);
await page.emulateMedia({ media: 'screen' });

// ---- when the clipboard says no, Copy list and Copy shopping list show the text to copy by hand
await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')); });
await page.click('.pagehead #copy');
await page.waitForSelector('.sheet textarea');
assert.match(await page.inputValue('.sheet textarea'), /^Moved part 03 ×1\n/);
await page.click('.sheet #done');
await page.goto(base + '#bom'); await page.click('#out #copy');
await page.waitForSelector('.sheet textarea');
assert.equal(await page.inputValue('.sheet textarea'), '0.2 m heat shrink tubing 3mm');
await page.click('.sheet #done');
await page.reload(); // the pretend clipboard again

// ---- photo ids from the Stockroom artifact (its photos stayed on claude.ai) show the icon, or the reference photo
const blobs = []; page.on('request', r => { if (r.url().includes('/_blob/')) blobs.push(r.url()); });
await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.bins['bin-env'].photo = 'asset-abc123'; d.items.parts['p-scd41'].photo = 'asset-def456'; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
await page.goto(base + '#bins'); await page.waitForSelector('.bin:has-text("Environmental") .photo svg', { state: 'attached' }); // on a phone the tile has no picture box
await page.goto(base + '#part/p-scd41'); await page.waitForFunction(() => document.querySelector('.binhead .refphoto img.ref')?.naturalWidth > 0);
assert.deepEqual(blobs, [], 'asked this site for a photo it can’t have');
const desk = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await desk.goto(base);

// ---- a bag number on two parts (two devices numbering bags before they'd synced): flagged where bags are numbered,
// listed under Parts with the numbers no part has, the tag opens the bag that has it, and the other part takes a new number
{
  const pad = n => String(n).padStart(3, '0');
  const live = Object.entries(await page.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts)).filter(([, x]) => !(x.del >= (x.t || 0)));
  const maxBag = Math.max(...live.map(([, x]) => Number(x.bag) || 0));
  const [tid, tp] = live.find(([, x]) => x.tagWritten && Number(x.bag) > 0), n = Number(tp.bag);
  await page.goto(base + '#bins'); await page.waitForSelector('.bin');
  assert.equal(await page.locator('.clashbar').count(), 0, 'nothing to flag yet');
  // what a sync brings in: another device's untagged part on the same number, and a bag two above the highest
  await page.evaluate(([n, max]) => { const d = JSON.parse(localStorage.getItem('parts-bin')), t = Date.now();
    d.items.parts['p-clash'] = { name: 'Buzzer module', bag: n, qty: 5, unit: 'pcs', tags: [], t };
    d.items.parts['p-far'] = { name: 'Far bag', bag: max + 2, qty: 1, unit: 'pcs', tags: [], t };
    localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); }, [n, maxBag]);
  await page.waitForSelector(`.clashbar:has-text("#${pad(n)}")`);
  assert.match(await page.textContent('#toast'), new RegExp(`Bag #${pad(n)} is now on more than one part`));
  await page.goto(base + '#scan'); await page.waitForSelector('.clashbar'); // where the next number is handed out
  assert.ok(await page.$eval('.clashbar', e => e.classList.contains('short') && e.getBoundingClientRect().height < 50), 'Pack’s bag number note is more than one line');
  await page.click('.clashbar #showclash'); await page.waitForSelector('.item');
  assert.equal(await page.evaluate(() => location.hash), '#parts');
  assert.deepEqual(await page.locator('.item .t').allTextContents(), [tp.name, 'Buzzer module'], 'the part with the tag first');
  assert.equal(await page.locator('.item .chip:has-text("bag used twice")').count(), 2);
  assert.match(await page.textContent('.gapnote'), new RegExp(`On no part: #${pad(maxBag + 1)}\\.`));
  // numbers on no part are runs, not every number one by one (a bag numbered #1001 listed #001, #002 … #030 and 970 more),
  // on one line on a phone, with Show all
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts['p-high'] = { name: 'High bag', bag: 1001, qty: 1, unit: 'pcs', tags: [], t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await page.waitForSelector('.gapnote .runs:has-text("–#1000")');
  assert.equal(await page.textContent('.gapnote .runs'), `On no part: #${pad(maxBag + 1)}, #${pad(maxBag + 3)}–#1000.`);
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); for (let i = 0; i < 40; i++) d.items.parts['p-odd' + i] = { name: 'Odd ' + i, bag: 1003 + 2 * i, qty: 1, unit: 'pcs', tags: [], t: Date.now() }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await page.waitForSelector('.gapnote button:not([hidden]):text-is("Show all")');
  const lineH = () => page.$eval('.gapnote .runs', e => e.getBoundingClientRect().height);
  assert.ok(await lineH() < 25, 'the numbers on no part are more than a line on a phone');
  await page.click('.gapnote button'); assert.ok(await lineH() > 40, 'Show all showed no more');
  assert.equal(await page.getAttribute('.gapnote button', 'aria-expanded'), 'true');
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')), t = Date.now() + 1000; for (const k of Object.keys(d.items.parts)) if (k === 'p-high' || k.startsWith('p-odd')) d.items.parts[k].del = t; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await page.waitForFunction(() => !document.querySelector('.gapnote .runs')?.textContent.includes('1000'));
  // the tag for that number opens the bag that has the tag, which names the other part
  await page.goto(base + '#bag/' + pad(n)); await page.waitForSelector('.clash');
  assert.equal(await page.textContent('.binhead h2'), tp.name);
  assert.equal(await page.locator('.binhead .bagbadge.twice').count(), 1); // the number under the photo turns amber too
  assert.match(await page.textContent('.clash'), /Also on Buzzer module.*give the other part a new number/);
  // the other part takes the next number, and its tag is written in the same go
  await page.click('.clash a'); await page.waitForSelector('.binhead h2:text-is("Buzzer module")'); await page.waitForSelector('#renumber');
  assert.match(await page.textContent('.clash'), /That one has the tag, so give this one a new number/);
  const nb = maxBag + 3;
  assert.equal(await page.textContent('#renumber'), `New number: #${pad(nb)}`);
  await page.click('#renumber'); await page.waitForSelector('.sheet #p-bag');
  assert.equal(await page.inputValue('#p-bag'), String(nb)); assert.ok(await page.isChecked('#p-dotag'));
  await page.click('.sheet #save'); await tapTag(true);
  assert.equal((await page.evaluate(() => window.__written)).at(-1), base + '#bag/' + pad(nb));
  assert.equal((await part('p-clash')).bag, nb); assert.equal((await part(tid)).bag, n);
  await page.waitForFunction(() => !document.querySelector('.clash'));
  await page.goto(base + '#bins'); await page.waitForSelector('.bin'); assert.equal(await page.locator('.clashbar').count(), 0);
  await page.goto(base + '#parts'); await page.waitForSelector('.empty:has-text("No bag number is on more than one part")');
  // tidy up for what follows
  await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')), t = Date.now() + 1000; d.items.parts['p-clash'].del = t; d.items.parts['p-far'].del = t;
    localStorage.setItem('parts-bin', JSON.stringify(d)); localStorage.setItem('sr.cat', '""'); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await page.goto(base + '#bins'); await page.waitForSelector('.bin');
}

// ---- Pack with parts already in bags: a fresh phone with a bin, a moving box picked to pack into, BME280 in tagged bag
// #001, SCD41 in tagged bag #002, a buzzer that another device also numbered #002, and SGP30 not bagged yet
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'bin-env': { code: 'ENV', name: 'Environmental', location: 'Workroom', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', location: 'Moving boxes', t: 1 } },
    parts: {
      'p-bme': { name: 'BME280 (Adafruit)', binId: 'bin-env', category: 'Sensors', qty: 3, unit: 'pcs', tags: [], bag: 1, tagWritten: true, t: 1 },
      'p-scd': { name: 'SCD41', binId: 'bin-env', category: 'Sensors', qty: 2, unit: 'pcs', tags: [], bag: 2, tagWritten: true, t: 1 },
      'p-buzz': { name: 'Buzzer', category: '', qty: 1, unit: 'pcs', tags: [], bag: 2, t: 1 },
      'p-sgp': { name: 'SGP30', binId: 'bin-env', category: '', qty: 1, unit: 'pcs', tags: [], t: 1 },
    } } });
  const bagCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await bagCtx.addInitScript(fakeNfc);
  await bagCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) { localStorage.setItem('parts-bin', d); localStorage.setItem('sr.packbox', '"box-1"'); } }, seed);
  const pg = await bagCtx.newPage();
  pg.problems = []; pg.on('pageerror', e => pg.problems.push(e.message)); pg.on('console', m => { if (m.type() === 'error') pg.problems.push(m.text()); });
  const got = id => pg.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  const gone = () => pg.waitForFunction(() => !document.querySelector('.sheet'));
  await pg.goto(base + '#scan'); await pg.waitForSelector('#desc');
  assert.equal(await pg.inputValue('#dest'), 'box-1');
  // picking BME280 keeps it in bag #001 (it used to be given the next number, and the sticker on its bag opened "No bag"),
  // with its tag left as it is
  await pg.fill('#desc', 'BME280'); await pg.click('.matchlist [data-id="p-bme"]');
  await pg.waitForSelector('.sheet #p-bag');
  assert.equal(await pg.inputValue('#p-bag'), '1'); assert.equal(await pg.isChecked('#p-dotag'), false);
  assert.equal(await pg.textContent('.sheet #save'), 'Save');
  await pg.click('.sheet #save'); await gone();
  let bme = await got('p-bme');
  assert.equal(bme.bag, 1); assert.equal(bme.binId, 'box-1'); assert.equal(bme.tagWritten, true);
  assert.equal(await pg.evaluate(() => window.__tap()), false, 'no tag sheet waiting');
  assert.match(await pg.textContent('.packhead .big'), /#003/, 'the next bag number didn’t move on');
  await pg.goto(base + '#bag/001'); await pg.waitForSelector('.binhead h2');
  assert.equal(await pg.textContent('.binhead h2'), 'BME280 (Adafruit)', 'the sticker on bag #001 still opens it');
  // it remembers the bin it came out of (Pack used to lose it), and the box's printed list shows it
  assert.equal(bme.from, 'ENV');
  await pg.goto(base + '#bin/box-1'); await pg.evaluate(() => { window.print = () => {}; }); await pg.click('#print');
  assert.deepEqual(await pg.locator('#print-root tbody td').allTextContents(), ['', '#001', 'BME280 (Adafruit)', '3', 'ENV', '']);
  // a box to tick on each line, and the number headings over their numbers (they sat 80 px to the left of them)
  assert.deepEqual(await pg.locator('#print-root thead th').allTextContents(), ['Done', 'Bag', 'Item', 'Qty', 'From', 'Notes']);
  assert.equal(await pg.locator('#print-root td.tick span').count(), 1);
  await pg.emulateMedia({ media: 'print' });
  assert.deepEqual(await pg.$$eval('#print-root th.n', ts => ts.map(t => getComputedStyle(t).textAlign)), ['right', 'right']);
  assert.equal(await pg.$eval('#print-root h1 .code', e => [getComputedStyle(e).borderTopStyle, getComputedStyle(e).backgroundColor].join()), 'solid,rgb(255, 255, 255)');
  await pg.emulateMedia({ media: 'screen' });
  assert.match(await pg.textContent('#print-root .sub'), / · 1 bag · /);
  // unpacking it puts it back in a bin, and it no longer says where it was
  await pg.selectOption('#unpack-to', 'bin-env'); await pg.click('button[aria-label="Move #001 to ENV"]');
  await pg.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-bme'].binId === 'bin-env');
  assert.equal((await got('p-bme')).from, '');
  // a part with no bag yet gets the next number, and its tag is written
  await pg.goto(base + '#scan'); await pg.fill('#desc', 'SGP30'); await pg.click('.matchlist [data-id="p-sgp"]');
  await pg.waitForSelector('.sheet #p-bag');
  assert.equal(await pg.inputValue('#p-bag'), '3'); assert.ok(await pg.isChecked('#p-dotag'));
  await pg.click('.sheet #save'); await pg.waitForSelector('#tz.wait'); await pg.evaluate(() => window.__tap()); await gone();
  assert.equal((await got('p-sgp')).bag, 3); assert.equal((await got('p-sgp')).tagWritten, true);

  // SCD41 has the tag for #002 and the buzzer doesn't: SCD41's page offers to renumber the buzzer, not itself (it used to
  // renumber SCD41, leaving its sticker opening the buzzer)
  await pg.goto(base + '#part/p-scd'); await pg.waitForSelector('.clash');
  assert.equal(await pg.locator('#renumber').count(), 0, 'the tagged part offers to renumber itself');
  assert.equal(await pg.textContent('.clash [data-renumber]'), 'Renumber Buzzer: #004');
  await pg.click('.clash [data-renumber]'); await pg.waitForSelector('.sheet #p-bag');
  assert.equal(await pg.inputValue('#p-name'), 'Buzzer'); assert.equal(await pg.inputValue('#p-bag'), '4'); assert.ok(await pg.isChecked('#p-dotag'));
  await pg.click('.sheet #cancel'); await gone();
  await pg.goto(base + '#part/p-buzz'); await pg.waitForSelector('.clash');
  assert.equal(await pg.textContent('#renumber'), 'New number: #004');

  // the bag box says what a new number does to the old bag, and saving one leaves no tag claimed for it
  await pg.goto(base + '#part/p-scd'); await pg.click('#edit'); await pg.waitForSelector('.sheet #p-bag');
  assert.equal(await pg.textContent('.bt-head'), 'Rewrite this bag’s tag when I save'); assert.equal(await pg.textContent('#p-bagnote'), '');
  await pg.fill('#p-bag', '9');
  assert.equal(await pg.textContent('.bt-head'), 'Put it in bag #009 and tag it when I save');
  assert.equal(await pg.textContent('#p-bagnote'), 'Bag #002’s tag will stop opening this part; write #009 on the new bag.');
  assert.equal(await pg.textContent('#p-bagshow'), '#009');
  await pg.click('.sheet #save'); await gone();
  assert.equal((await got('p-scd')).bag, 9); assert.equal((await got('p-scd')).tagWritten, false, 'no tag carries #009 yet');

  // Enter straight after typing (a pasted name, or the keyboard's Go) opens the sheet; it used to do nothing until the
  // matches showed
  await pg.goto(base + '#scan'); await pg.fill('#desc', 'BME280'); await pg.press('#desc', 'Enter');
  await pg.waitForSelector('.sheet #p-name', { timeout: 1000 });
  assert.equal(await pg.inputValue('#p-name'), 'BME280 (Adafruit)'); assert.equal(await pg.inputValue('#p-bag'), '1');
  await pg.click('.sheet #cancel'); await gone();
  await pg.fill('#desc', 'Hot glue sticks'); await pg.press('#desc', 'Enter');
  await pg.waitForSelector('.sheet #p-name', { timeout: 1000 });
  assert.equal(await pg.inputValue('#p-name'), 'Hot glue sticks'); assert.equal(await pg.textContent('.sheet h3'), 'New part');
  await pg.click('.sheet #cancel'); await gone();

  // two tabs packing at once: the number tab A's sheet shows is taken in tab B before A saves. A gets the next number and
  // is told, rather than "already used" and a number to work out
  await pg.goto(base + '#scan'); await pg.fill('#desc', 'Race part A'); await pg.press('#desc', 'Enter'); await pg.waitForSelector('.sheet #p-bag');
  assert.equal(await pg.inputValue('#p-bag'), '10');
  const tb = await bagCtx.newPage();
  await tb.goto(base + '#scan'); await tb.fill('#desc', 'Race part B'); await tb.press('#desc', 'Enter'); await tb.waitForSelector('.sheet #p-bag');
  assert.equal(await tb.inputValue('#p-bag'), '10');
  await tb.click('.sheet #save'); await tb.waitForSelector('#tz.wait'); await tb.evaluate(() => window.__tap()); await tb.waitForFunction(() => !document.querySelector('.sheet'));
  await tb.close();
  await pg.waitForFunction(() => document.querySelector('#p-bag').placeholder === '11' || document.querySelector('.packhead .big').textContent === '#011');
  await pg.click('.sheet #save');
  await pg.waitForSelector('#toast:has-text("Bag #010 was just used, so this is bag #011. Tap Save & tag again.")');
  assert.equal(await pg.inputValue('#p-bag'), '11'); assert.equal(await pg.textContent('#p-bagshow'), '#011');
  assert.equal(await pg.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.parts).some(x => x.name === 'Race part A')), false, 'saved on the tap that found the number taken');
  await pg.click('.sheet #save'); await pg.waitForSelector('#tz.wait'); await pg.evaluate(() => window.__tap()); await gone();
  assert.equal(await pg.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(x => x.name === 'Race part A').bag), 11);
  // a number typed in that's in use still just says so
  await pg.goto(base + '#part/p-sgp'); await pg.click('#edit'); await pg.fill('#p-bag', '11'); await pg.click('.sheet #save');
  await pg.waitForSelector('#toast:has-text("Bag #011 is already used")'); assert.equal(await pg.inputValue('#p-bag'), '11');
  await pg.click('.sheet #cancel'); await gone();

  // skipping the tag after a save still says it was saved (nothing did)
  await pg.goto(base + '#scan'); await pg.fill('#desc', 'Hot glue sticks'); await pg.press('#desc', 'Enter'); await pg.waitForSelector('.sheet #p-bag');
  await pg.click('.sheet #save'); await pg.waitForSelector('#tz.wait'); await pg.click('.sheet #done'); await gone();
  await pg.waitForSelector('#toast:has-text("Saved as bag #012")');

  // a match with no category or bin reads cleanly (it was "#002 ·  · in stock 1")
  await pg.goto(base + '#scan'); await pg.fill('#desc', 'Buzzer'); await pg.waitForSelector('.matchlist [data-id="p-buzz"]');
  assert.equal(await pg.textContent('.matchlist [data-id="p-buzz"] .s'), '#002 · in stock 1');
  await pg.fill('#desc', 'SGP30'); await pg.waitForSelector('.matchlist [data-id="p-sgp"]');
  assert.equal(await pg.textContent('.matchlist [data-id="p-sgp"] .s'), '#003 · in stock 1 · BOX 01');
  await pg.fill('#desc', '');

  // Bins lists what's in no bin at the end, so nothing packed is out of sight; it opens those parts in Parts
  await pg.goto(base + '#bins'); await pg.waitForSelector('.section-h:has-text("Not in a bin")');
  assert.equal(await pg.textContent('.section-h:has-text("Not in a bin") .tiny'), '1 part');
  await pg.click('#nobin'); await pg.waitForFunction(() => location.hash === '#parts');
  assert.equal(await pg.inputValue('#cat'), '__nobin'); assert.deepEqual(await pg.locator('.item .t').allTextContents(), ['Buzzer']);
  await pg.selectOption('#cat', '');
  // a new bin is where the next Pack starts, and its page (empty or not) packs into it
  await pg.goto(base + '#bins'); await pg.click('#addbin'); await pg.fill('#f-code', 'B09'); await pg.click('.sheet #save');
  await pg.waitForFunction(() => location.hash.startsWith('#bin/') && !document.querySelector('.sheet'));
  const b09 = await pg.evaluate(() => location.hash.slice(5));
  await pg.goto(base + '#scan'); assert.equal(await pg.inputValue('#dest'), b09);
  await pg.selectOption('#dest', 'bin-env');
  await pg.goto(base + '#bin/' + b09); await pg.click('#main .empty >> text=Pack into this bin');
  await pg.waitForFunction(() => location.hash === '#scan'); assert.equal(await pg.inputValue('#dest'), b09);
  // Pack makes a bin as well as a box
  await pg.click('.packhead #newbin'); await pg.waitForSelector('.sheet #f-kind');
  assert.equal(await pg.inputValue('#f-kind'), 'bin'); await pg.click('.sheet #cancel'); await gone();

  // a sticker whose number no part has now says what may have happened, and where to go from there (it was a dead end)
  await pg.goto(base + '#bag/042'); await pg.waitForSelector('#main .empty');
  assert.equal(await pg.textContent('#main .empty p'), 'No part has bag #042 now. It may have been renumbered or deleted.');
  await pg.click('#main .empty >> text=Search parts'); await pg.waitForFunction(() => location.hash === '#parts' && document.activeElement?.id === 'q');
  await pg.goto(base + '#bag/042'); await pg.click('#main .empty >> text=All bins'); await pg.waitForFunction(() => location.hash === '#bins');

  // two tabs: tab A has a part's sheet open and types a note while tab B takes two off its count. Saving A keeps B's count
  // (it used to put back the count A's sheet opened with) and the note
  await pg.goto(base + '#part/p-bme'); await pg.click('#edit'); await pg.waitForSelector('.sheet #p-notes');
  const before = await got('p-bme');
  await pg.fill('#p-notes', 'Bosch, from the 2024 order');
  const tabB2 = await bagCtx.newPage();
  await tabB2.goto(base + '#part/p-bme'); await tabB2.click('#dec'); await tabB2.click('#dec');
  await pg.waitForFunction(q => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-bme'].qty === q, before.qty - 2);
  await tabB2.close();
  assert.equal(await pg.inputValue('#p-qty'), String(before.qty), 'the sheet still shows the count it opened with');
  await pg.click('.sheet #save'); await gone();
  bme = await got('p-bme');
  assert.equal(bme.qty, before.qty - 2, 'the other tab’s count stays'); assert.equal(bme.notes, 'Bosch, from the 2024 order');
  assert.equal(bme.bag, before.bag); assert.equal(bme.tagWritten, true); assert.equal(bme.binId, before.binId);
  // a count typed into the sheet still wins
  await pg.click('#edit'); await pg.fill('#p-qty', '7'); await pg.click('.sheet #save'); await gone();
  assert.equal((await got('p-bme')).qty, 7);

  assert.deepEqual(pg.problems, [], 'problems while packing bagged parts');
  await bagCtx.close();
}

// ---- unpacking a box: rows in bag order, each saying where it came from; one tap puts a bag back there, Undo takes it back,
// a bag put back in the box keeps where it came from, Put them all back, and an emptied box offers Delete box
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 }, 'b-pwr': { code: 'PWR', name: 'Power', t: 1 }, 'b-mcu': { code: 'MCU', name: 'Boards', t: 1 }, 'b-led': { code: 'LED', name: 'Lights', t: 1 },
      'box-u': { code: 'BOX 01', kind: 'box', name: 'Bench', location: 'Moving boxes', t: 1 } },
    parts: {
      'p-ina': { name: 'INA219', binId: 'box-u', qty: 2, unit: 'pcs', tags: [], bag: 10, from: 'pwr', t: 1 },
      'p-ssd': { name: 'SSD1306', binId: 'box-u', qty: 1, unit: 'pcs', tags: [], bag: 3, from: 'MCU', t: 1 },
      'p-vl5': { name: 'VL53L1X', binId: 'box-u', qty: 1, unit: 'pcs', tags: [], bag: 7, from: 'ENV', t: 1 },
      'p-aar': { name: 'Aardvark', binId: 'box-u', qty: 1, unit: 'pcs', tags: [], bag: 12, from: 'GONE', t: 1 },
      'p-zet': { name: 'Zeta', binId: 'box-u', qty: 1, unit: 'pcs', tags: [], t: 1 },
    } } });
  const uCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await uCtx.addInitScript(fakeNfc);
  await uCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const up = await uCtx.newPage();
  up.problems = []; up.on('pageerror', e => up.problems.push(e.message)); up.on('console', m => { if (m.type() === 'error') up.problems.push(m.text()); });
  const got = id => up.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  const binOf = async id => (await got(id)).binId;
  const until = (id, bin) => up.waitForFunction(([id, bin]) => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].binId === bin, [id, bin]);
  await up.goto(base + '#bin/box-u'); await up.waitForSelector('.unpack');
  // in bag order, as the bags in hand and the printed list are (they were by name), with the unnumbered last
  assert.deepEqual(await up.locator('.unpack .item .t').allTextContents(), ['SSD1306', 'VL53L1X', 'INA219', 'Aardvark', 'Zeta']);
  // each says where it came from, when that bin is still here (the code matched whatever its case)
  assert.match(await up.textContent('.unpack:nth-child(3) .item .s'), /from PWR/);
  assert.doesNotMatch(await up.textContent('.unpack:nth-child(4) .item .s'), /from/, 'a bin that’s gone');
  // left on Where each came from, a bag's button names its bin and one tap puts it back
  assert.equal(await up.$eval('#unpack-to option', o => o.textContent), 'Where each came from');
  const ina = up.getByRole('button', { name: 'Move #010 back to PWR', exact: true });
  assert.equal((await ina.textContent()).trim(), '→ PWR');
  await ina.click(); await until('p-ina', 'b-pwr');
  let p = await got('p-ina');
  assert.equal(p.from, ''); assert.ok(!('box' in p), 'an empty box field written on the part');
  // Undo puts it back in the box, still saying where it came from
  await up.waitForSelector('#toast button:has-text("Undo")');
  assert.match(await up.textContent('#toast'), /#010 → PWR/);
  await up.click('#toast button'); await until('p-ina', 'box-u');
  assert.equal((await got('p-ina')).from, 'pwr');
  // with a bin picked, every button goes there; a bag sent there by mistake and put back through Edit keeps where it came from
  await up.selectOption('#unpack-to', 'b-led');
  const inaLed = up.getByRole('button', { name: 'Move #010 to LED', exact: true });
  assert.equal((await inaLed.textContent()).trim(), '→ LED');
  await inaLed.click(); await until('p-ina', 'b-led');
  await up.goto(base + '#part/p-ina'); await up.click('#edit'); await up.selectOption('#p-bin', 'box-u'); await up.click('.sheet #save');
  await until('p-ina', 'box-u');
  assert.equal((await got('p-ina')).from, 'pwr', 'putting it back in its box gave it the bin it was sent to by mistake');
  // Put them all back: the three whose bins are here go back, the two with none stay for the picker
  await up.goto(base + '#bin/box-u'); await up.selectOption('#unpack-to', '');
  assert.equal((await up.textContent('#putback')).trim(), 'Put them all back (3)');
  const asked = new Promise(r => up.once('dialog', d => { r(d.message()); d.accept(); }));
  await up.click('#putback');
  assert.equal(await asked, 'Put 3 bags back in the bins they came from? 2 have no bin to go back to and stay.');
  await until('p-vl5', 'b-env');
  assert.deepEqual([await binOf('p-ina'), await binOf('p-ssd'), await binOf('p-vl5'), await binOf('p-aar'), await binOf('p-zet')], ['b-pwr', 'b-mcu', 'b-env', 'box-u', 'box-u']);
  await up.waitForSelector('#toast:has-text("3 bags put back")');
  // a bag with nowhere to go back to asks for a bin
  await up.getByRole('button', { name: 'Move #012: choose a bin first', exact: true }).click();
  await up.waitForSelector('#toast:has-text("choose")');
  // the last two go to a bin picked, and the empty box says so and offers to delete it
  await up.selectOption('#unpack-to', 'b-led');
  await up.getByRole('button', { name: 'Move #012 to LED', exact: true }).click(); await until('p-aar', 'b-led');
  await up.getByRole('button', { name: 'Move Zeta to LED', exact: true }).click(); await until('p-zet', 'b-led');
  await up.waitForSelector('text=Everything’s unpacked.');
  const askedDel = new Promise(r => up.once('dialog', d => { r(d.message()); d.accept(); }));
  await up.click('#delbox'); assert.equal(await askedDel, 'Delete box BOX 01?');
  await up.waitForFunction(() => location.hash === '#bins');
  assert.ok(JSON.parse(await up.evaluate(() => localStorage.getItem('parts-bin'))).items.bins['box-u'].del, 'the box was deleted');
  assert.deepEqual(up.problems, []);
  await uCtx.close();
}

// ---- holding one tag after another: each page a tag opens takes the place of the one the tag before it opened, so one
// Back goes to where you were before the first (it went back through every bag held up); a page opened from a link is a
// step of its own, as before
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 }, 'b-pwr': { code: 'PWR', name: 'Power', t: 1 } },
    parts: {
      'p-a': { name: 'BME280', binId: 'b-env', qty: 2, unit: 'pcs', tags: [], bag: 1, tagWritten: true, t: 1 },
      'p-b': { name: 'INA219', binId: 'b-pwr', qty: 1, unit: 'pcs', tags: [], bag: 2, tagWritten: true, t: 1 },
      'p-c': { name: 'SCD41', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], bag: 3, tagWritten: true, t: 1 },
    } } });
  const tCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await tCtx.addInitScript(fakeNfc);
  await tCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const tp = await tCtx.newPage();
  tp.problems = []; tp.on('pageerror', e => tp.problems.push(e.message)); tp.on('console', m => { if (m.type() === 'error') tp.problems.push(m.text()); });
  const hold = async (url, hash) => { await tp.evaluate(u => window.__read(u), url); await tp.waitForFunction(h => location.hash === h, hash); await tp.waitForSelector('.binhead'); };
  const back = async hash => { await tp.evaluate(() => history.back()); await tp.waitForFunction(h => location.hash === h, hash); };
  await tp.goto(base + '#parts'); await tp.waitForSelector('#main .list .item');
  await tp.goto(base + '#bins'); await tp.waitForSelector('.bin');
  await tp.waitForFunction(() => !!window.__reader);
  await hold(base + '#bag/001', '#bag/001');
  await hold(base + '#bag/002', '#bag/002');
  await hold(base + '#bin/b-pwr', '#bin/b-pwr');
  await hold(base + '#bag/003', '#bag/003');
  await back('#bins');
  await back('#parts');
  // a link on a page a tag opened is a step of its own, and the next tag doesn't take its place
  await tp.goto(base + '#bins'); await tp.waitForSelector('.bin');
  await hold(base + '#bag/001', '#bag/001');
  await tp.click('.binhead a[href="#bin/b-env"]'); await tp.waitForFunction(() => location.hash === '#bin/b-env');
  await hold(base + '#bag/002', '#bag/002');
  await back('#bin/b-env');
  await back('#bag/001');
  await back('#bins');
  // the same tag held again on its own page, then another: Back still goes to where the first was held
  await hold(base + '#bag/003', '#bag/003');
  await tp.evaluate(() => window.__read(location.origin + '/#bag/003')); await tp.waitForTimeout(150);
  await hold(base + '#bag/001', '#bag/001');
  await back('#bins');
  assert.deepEqual(tp.problems, []);
  await tCtx.close();
}

// ---- old Stockroom tags rewritten without asking: ticked once on "Update this tag?", each old tag held goes straight to
// writing the new link over it; Settings asks each time again
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 } },
    parts: {
      'p-a': { name: 'BME280', binId: 'b-env', qty: 2, unit: 'pcs', tags: [], bag: 1, tagWritten: true, t: 1 },
      'p-b': { name: 'INA219', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], bag: 2, tagWritten: true, t: 1 },
      'p-c': { name: 'SCD41', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], t: 1 },
    } } });
  const oCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await oCtx.addInitScript(fakeNfc);
  await oCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const op = await oCtx.newPage();
  op.problems = []; op.on('pageerror', e => op.problems.push(e.message)); op.on('console', m => { if (m.type() === 'error') op.problems.push(m.text()); });
  const OLD = 'https://claude.ai/artifact/3tWd7DUCw34ExEy7Jo4CpG';
  const closed = () => op.waitForFunction(() => !document.querySelector('.sheet'));
  await op.goto(base + '#bins'); await op.waitForFunction(() => !!window.__reader?.onreading);
  // asked the first time, with the tick unticked; Rewrite tag with it ticked remembers it
  await op.evaluate(u => window.__read(u + '#bag/001'), OLD);
  await op.waitForSelector('.sheet:has-text("Update this tag?")');
  assert.equal(await op.isChecked('.sheet #always'), false);
  assert.equal(await op.textContent('.sheet label[for="always"]'), 'Don’t ask again: rewrite old tags as I hold them');
  await op.check('.sheet #always'); await op.click('.sheet #go');
  await op.waitForSelector('#tz.wait');
  await op.evaluate(() => window.__tap()); await closed();
  assert.equal((await op.evaluate(() => window.__written)).at(-1), base + '#bag/001');
  await op.waitForTimeout(3100); // past the "just written" pause
  // the next old tag goes straight to the write, already listening, and says why
  await op.goto(base + '#bins'); await op.waitForSelector('.bin');
  await op.evaluate(u => window.__read(u + '#bag/002'), OLD);
  await op.waitForSelector('#tz.wait');
  assert.equal(await op.locator('.sheet:has-text("Update this tag?")').count(), 0);
  assert.match(await op.textContent('.sheet p.muted'), /Old tags are rewritten as you hold them/);
  assert.equal(await op.evaluate(() => location.hash), '#bag/002');
  await op.evaluate(() => window.__tap()); await closed();
  assert.equal((await op.evaluate(() => window.__written)).at(-1), base + '#bag/002');
  await op.waitForTimeout(3100);
  // a part with no bag yet gets the next number as its tag is rewritten
  await op.evaluate(u => window.__read(u + '#part/p-c'), OLD);
  await op.waitForSelector('#tz.wait');
  await op.evaluate(() => window.__tap()); await closed();
  assert.equal((await op.evaluate(() => window.__written)).at(-1), base + '#bag/003');
  assert.equal(await op.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-c'].bag), 3);
  await op.waitForTimeout(3100);
  // Settings says so, and Ask each time brings the question back
  await op.goto(base + '#settings'); await op.waitForSelector('#askold');
  assert.match(await op.textContent('#oldtags'), /^Old Stockroom tags are rewritten as you hold them, without asking\./);
  await op.click('#askold'); await op.waitForSelector('#askold', { state: 'detached' });
  await op.goto(base + '#bins'); await op.waitForSelector('.bin');
  await op.evaluate(u => window.__read(u + '#bag/001'), OLD);
  await op.waitForSelector('.sheet:has-text("Update this tag?")');
  // Not now with the tick ticked doesn't stop it asking
  await op.check('.sheet #always'); await op.click('.sheet #later'); await closed();
  assert.equal(await op.evaluate(() => localStorage.getItem('pb.rewriteold')), 'false');
  await op.goto(base + '#settings'); await op.waitForSelector('#drivecard');
  assert.equal(await op.locator('#askold').count(), 0);
  assert.deepEqual(op.problems, []);
  await oCtx.close();
}

// ---- Copy as new part: from a part's Edit sheet, a new part with its category, unit, bin, keywords, reorder level and
// specs, a count of 1, the next bag number and its name ready to change; the part copied stays as it was
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-pas': { code: 'PAS', name: 'Passives', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', t: 1 } },
    parts: {
      'p-10k': { name: 'Resistor 10k 1/4W', binId: 'b-pas', category: 'Resistors', qty: 80, unit: 'pcs', minQty: 20, tags: ['through-hole', '1%'], mpn: 'CF14JT10K0', notes: 'From the kit', link: 'https://example.com/10k', iface: ['I2C'], volts: '250 V', bag: 4, tagWritten: true, t: 1 },
      'p-wire': { name: 'Hookup wire red', binId: 'box-1', from: 'WIRE', category: 'Wire', qty: 3, unit: 'm', tags: [], bag: 9, t: 1 },
    } } });
  const cCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await cCtx.addInitScript(fakeNfc);
  await cCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const cp = await cCtx.newPage();
  cp.problems = []; cp.on('pageerror', e => cp.problems.push(e.message)); cp.on('console', m => { if (m.type() === 'error') cp.problems.push(m.text()); });
  const parts = () => cp.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts);
  const closed = () => cp.waitForFunction(() => !document.querySelector('.sheet'));
  await cp.goto(base + '#part/p-10k'); await cp.waitForSelector('#edit');
  const before = (await parts())['p-10k'];
  await cp.click('#edit'); await cp.waitForSelector('.sheet #copyp');
  assert.equal(await cp.locator('.sheet #copyp').count(), 1);
  await cp.click('.sheet #copyp'); await cp.waitForSelector('.sheet h3:text("New part")');
  assert.match(await cp.textContent('.sheet p.muted'), /^A copy of Resistor 10k 1\/4W\. Change the name, then save\.$/);
  assert.equal(await cp.locator('.sheet #copyp').count(), 0, 'a new part has nothing to copy yet');
  // the name ready to change: it has the keyboard, all of it selected
  assert.deepEqual(await cp.evaluate(() => { const f = document.activeElement; return [f.id, f.selectionStart, f.selectionEnd, f.value.length]; }), ['p-name', 0, 17, 17]);
  assert.equal(await cp.inputValue('#p-cat'), 'Resistors'); assert.equal(await cp.inputValue('#p-unit'), 'pcs');
  assert.equal(await cp.inputValue('#p-bin'), 'b-pas'); assert.equal(await cp.inputValue('#p-tags'), 'through-hole, 1%');
  assert.equal(await cp.inputValue('#p-min'), '20'); assert.equal(await cp.inputValue('#p-iface'), 'I2C'); assert.equal(await cp.inputValue('#p-volts'), '250 V');
  assert.equal(await cp.inputValue('#p-qty'), '1'); assert.equal(await cp.inputValue('#p-bag'), '10');
  assert.equal(await cp.inputValue('#p-mpn'), ''); assert.equal(await cp.inputValue('#p-notes'), ''); assert.equal(await cp.inputValue('#p-link'), '');
  await cp.keyboard.type('Resistor 4.7k 1/4W');
  await cp.click('.sheet #save'); await cp.waitForSelector('#tz.wait');
  await cp.evaluate(() => window.__tap()); await closed();
  const all = await parts(), mine = Object.entries(all).find(([, x]) => x.name === 'Resistor 4.7k 1/4W');
  assert.ok(mine, 'the copy was saved');
  const [cid, c] = mine;
  assert.deepEqual([c.category, c.unit, c.binId, c.tags, c.minQty, c.iface, c.volts, c.qty, c.bag, c.tagWritten, c.mpn, c.notes, c.from],
    ['Resistors', 'pcs', 'b-pas', ['through-hole', '1%'], 20, ['I2C'], '250 V', 1, 10, true, '', '', '']);
  assert.match((await cp.evaluate(() => window.__written)).at(-1), /#bag\/010$/);
  assert.deepEqual(all['p-10k'], before, 'the part copied changed');
  assert.notEqual(cid, 'p-10k');
  // what the sheet says when Copy is tapped is what's copied, and nothing changed there is saved to the part copied
  await cp.goto(base + '#part/p-10k'); await cp.click('#edit'); await cp.waitForSelector('.sheet #copyp');
  await cp.fill('#p-cat', 'Passives'); await cp.click('.sheet #copyp'); await cp.waitForSelector('.sheet h3:text("New part")');
  assert.equal(await cp.inputValue('#p-cat'), 'Passives');
  await cp.click('.sheet #cancel'); await closed();
  assert.equal((await parts())['p-10k'].category, 'Resistors');
  // a part in a box: the copy goes in the same box, from the same bin
  await cp.goto(base + '#part/p-wire'); await cp.click('#edit'); await cp.click('.sheet #copyp'); await cp.waitForSelector('.sheet h3:text("New part")');
  await cp.fill('#p-name', 'Hookup wire black'); assert.equal(await cp.inputValue('#p-unit'), 'm');
  await cp.click('.sheet #save'); await cp.waitForSelector('#tz.wait'); await cp.click('.sheet #done'); await closed();
  const w = Object.values(await parts()).find(x => x.name === 'Hookup wire black');
  assert.deepEqual([w.binId, w.from, w.unit, w.qty, w.bag], ['box-1', 'WIRE', 'm', 1, 11]);
  assert.deepEqual(cp.problems, []);
  await cCtx.close();
}

// ---- a second bag of a part that's in a bag already: Pack's matches offer "It's another bag of it" under it, which makes
// a second entry with its name and details, the next bag number and its own count (picking the part itself puts the
// count on its one bag)
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', t: 1 } },
    parts: {
      'p-bme': { name: 'BME280 (Adafruit)', binId: 'b-env', category: 'Sensors', qty: 3, unit: 'pcs', minQty: 1, tags: ['qwiic'], mpn: '2652', iface: ['I2C'], addr: '0x77', volts: '3.3–5 V', notes: 'Temp, humidity, pressure', bag: 1, tagWritten: true, t: 1 },
      'p-bmp': { name: 'BME680', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], bag: 2, t: 1 },
      'p-sgp': { name: 'BME sensor kit', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], t: 1 },
    } } });
  const aCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await aCtx.addInitScript(fakeNfc);
  await aCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) { localStorage.setItem('parts-bin', d); localStorage.setItem('sr.packbox', '"box-1"'); } }, seed);
  const ap = await aCtx.newPage();
  ap.problems = []; ap.on('pageerror', e => ap.problems.push(e.message)); ap.on('console', m => { if (m.type() === 'error') ap.problems.push(m.text()); });
  const parts = () => ap.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts);
  const closed = () => ap.waitForFunction(() => !document.querySelector('.sheet'));
  await ap.goto(base + '#scan'); await ap.waitForSelector('#desc');
  const before = (await parts())['p-bme'];
  await ap.fill('#desc', 'BME280'); await ap.waitForSelector('.matchlist [data-id="p-bme"]');
  // offered under the part named, in a bag; not under one with no bag (picking it bags it), nor one only partly named
  assert.deepEqual(await ap.locator('.matchlist [data-again]').evaluateAll(b => b.map(x => x.dataset.again)), ['p-bme']);
  assert.equal(await ap.textContent('.matchlist [data-again] span'), 'It’s another bag of it');
  assert.equal(await ap.getAttribute('.matchlist [data-again]', 'aria-label'), 'It’s another bag of BME280 (Adafruit): a new entry in bag #003');
  await ap.click('.matchlist [data-again="p-bme"]'); await ap.waitForSelector('.sheet #p-name');
  assert.match(await ap.textContent('.sheet p.muted'), /^Another bag of BME280 \(Adafruit\) \(#001\): a new entry with its own number, sticker and count\.$/);
  assert.equal(await ap.inputValue('#p-name'), 'BME280 (Adafruit)'); assert.equal(await ap.inputValue('#p-bag'), '3');
  assert.equal(await ap.inputValue('#p-qty'), '1'); assert.equal(await ap.inputValue('#p-bin'), 'box-1'); assert.equal(await ap.inputValue('#p-mpn'), '2652');
  await ap.fill('#p-qty', '5');
  assert.equal(await ap.textContent('.sheet #save'), 'Save & tag');
  await ap.click('.sheet #save'); await ap.waitForSelector('#tz.wait');
  assert.equal(await ap.textContent('.sheet #done'), 'Skip the tag');
  await ap.evaluate(() => window.__tap()); await closed();
  assert.match((await ap.evaluate(() => window.__written)).at(-1), /#bag\/003$/);
  const all = await parts(), twos = Object.entries(all).filter(([, x]) => x.name === 'BME280 (Adafruit)');
  assert.equal(twos.length, 2, 'a second entry');
  const [nid, n] = twos.find(([k]) => k !== 'p-bme');
  assert.deepEqual([n.category, n.unit, n.minQty, n.tags, n.mpn, n.iface, n.addr, n.volts, n.notes, n.qty, n.bag, n.binId, n.tagWritten, n.from],
    ['Sensors', 'pcs', 1, ['qwiic'], '2652', ['I2C'], '0x77', '3.3–5 V', 'Temp, humidity, pressure', 5, 3, 'box-1', true, '']);
  assert.deepEqual(all['p-bme'], before, 'the first bag changed');
  assert.match(await ap.textContent('.packhead .big'), /#004/);
  // each bag's sticker opens its own entry
  await ap.goto(base + '#bag/003'); await ap.waitForSelector('.binhead h2');
  assert.equal(await ap.evaluate(() => location.hash), '#bag/003');
  assert.equal(await ap.inputValue('#qv'), '5');
  // Enter still opens the part named, not another bag of it
  await ap.goto(base + '#scan'); await ap.waitForSelector('#desc');
  await ap.fill('#desc', 'BME680'); await ap.press('#desc', 'Enter'); await ap.waitForSelector('.sheet #p-name');
  assert.equal(await ap.inputValue('#p-bag'), '2'); assert.equal(await ap.locator('.sheet p.muted').count(), 0);
  await ap.click('.sheet #cancel'); await closed();
  assert.deepEqual(ap.problems, []);
  await aCtx.close();
}

// ---- Pack shows the last five bags saved into the box picked on this visit (number, name, count; each opens its part,
// with Tag on one whose tag isn't written), the picker says how full each box is, and what's typed survives a trip to a
// bag and back
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', t: 1 } },
    parts: { 'p-old': { name: 'Old thing', binId: 'box-1', qty: 1, unit: 'pcs', tags: [], bag: 1, tagWritten: true, t: 1 } } } });
  const kCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await kCtx.addInitScript(fakeNfc);
  await kCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) { localStorage.setItem('parts-bin', d); localStorage.setItem('sr.packbox', '"box-1"'); } }, seed);
  const kp = await kCtx.newPage();
  kp.problems = []; kp.on('pageerror', e => kp.problems.push(e.message)); kp.on('console', m => { if (m.type() === 'error') kp.problems.push(m.text()); });
  const closed = () => kp.waitForFunction(() => !document.querySelector('.sheet'));
  await kp.goto(base + '#scan'); await kp.waitForSelector('#desc');
  assert.equal(await kp.locator('.packed').count(), 0, 'nothing packed on this visit yet');
  assert.deepEqual(await kp.locator('#dest option').allTextContents(), ['— pick a box or bin —', 'BOX 01 · Bench · 1 bag', 'ENV · Environmental · 0 parts']);
  // seven bags, the last skipping its tag
  for (let i = 1; i <= 7; i++) {
    await kp.fill('#desc', `Widget ${i}`); await kp.press('#desc', 'Enter'); await kp.waitForSelector('.sheet #p-qty');
    await kp.fill('#p-qty', String(i * 10)); await kp.click('.sheet #save'); await kp.waitForSelector('#tz.wait');
    if (i < 7) { await kp.evaluate(() => window.__tap()); await kp.waitForTimeout(1700); } else await kp.click('.sheet #done');
    await closed();
  }
  await kp.waitForFunction(() => document.querySelectorAll('.packed .unpack').length === 5);
  assert.equal(await kp.textContent('.packed h3'), 'Packed into BOX 01 just now');
  assert.deepEqual(await kp.locator('.packed .item .t').allTextContents(), ['Widget 7', 'Widget 6', 'Widget 5', 'Widget 4', 'Widget 3']);
  assert.deepEqual(await kp.locator('.packed .item .bagno').allTextContents(), ['#008', '#007', '#006', '#005', '#004']);
  assert.deepEqual((await kp.locator('.packed .item .q').allTextContents()).map(s => s.trim()), ['70', '60', '50', '40', '30']);
  // only the bag whose tag wasn't written has Tag, and it writes it
  assert.deepEqual(await kp.locator('.packed .unpack > .btn').evaluateAll(b => b.map(x => x.getAttribute('aria-label'))), ['Tag #008']);
  assert.equal(await kp.$eval('#dest', s => s.selectedOptions[0].textContent), 'BOX 01 · Bench · 8 bags');
  await kp.click('.packed .unpack > .btn'); await kp.click('.sheet #write'); await kp.evaluate(() => window.__tap()); await closed();
  await kp.waitForFunction(() => document.querySelectorAll('.packed .unpack > .btn').length === 0);
  // a half-typed description survives opening a bag from the list and coming Back
  await kp.fill('#desc', 'Wid'); await kp.waitForSelector('.matchlist');
  await kp.click('.packed .item:has-text("Widget 5")'); await kp.waitForSelector('.binhead h2:text("Widget 5")');
  await kp.evaluate(() => history.back()); await kp.waitForSelector('#desc');
  assert.equal(await kp.inputValue('#desc'), 'Wid');
  await kp.waitForSelector('.matchlist [data-id]');
  // another box picked: its own list (none yet); back to BOX 01, the list is there again
  await kp.selectOption('#dest', 'b-env'); await kp.waitForFunction(() => !document.querySelector('.packed'));
  assert.equal(await kp.inputValue('#desc'), 'Wid', 'picking a box lost what was typed');
  await kp.selectOption('#dest', 'box-1'); await kp.waitForSelector('.packed');
  // a save empties the field for the next bag
  await kp.fill('#desc', 'Gadget'); await kp.press('#desc', 'Enter'); await kp.waitForSelector('.sheet #p-qty');
  await kp.click('.sheet #save'); await kp.click('.sheet #done'); await closed();
  assert.equal(await kp.inputValue('#desc'), '');
  assert.equal(await kp.textContent('.packed .item .t'), 'Gadget');
  assert.deepEqual(kp.problems, []);
  await kCtx.close();
}

// ---- unpacking a box by its bags' tags: on the box's page, holding a bag's sticker takes it out to where Unpack into says
// (where it came from, or the bin picked), with Undo, instead of opening it; read twice, it says where it went; a bag
// with nowhere to go asks for a bin; any other tag opens as usual
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 }, 'b-pwr': { code: 'PWR', name: 'Power', t: 1 }, 'box-u': { code: 'BOX 01', kind: 'box', name: 'Bench', t: 1 } },
    parts: {
      'p-ina': { name: 'INA219', binId: 'box-u', qty: 2, unit: 'pcs', tags: [], bag: 10, from: 'PWR', tagWritten: true, t: 1 },
      'p-vl5': { name: 'VL53L1X', binId: 'box-u', qty: 1, unit: 'pcs', tags: [], bag: 7, from: 'ENV', tagWritten: true, t: 1 },
      'p-zet': { name: 'Zeta', binId: 'box-u', qty: 1, unit: 'pcs', tags: [], bag: 12, tagWritten: true, t: 1 },
      'p-old': { name: 'Old sticker', binId: 'box-u', qty: 1, unit: 'pcs', tags: [], bag: 14, from: 'PWR', tagWritten: true, t: 1 },
      'p-out': { name: 'Elsewhere', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], bag: 20, tagWritten: true, t: 1 },
    } } });
  const uCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await uCtx.addInitScript(fakeNfc);
  await uCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const up = await uCtx.newPage();
  up.problems = []; up.on('pageerror', e => up.problems.push(e.message)); up.on('console', m => { if (m.type() === 'error') up.problems.push(m.text()); });
  const got = id => up.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  const until = (id, bin) => up.waitForFunction(([id, bin]) => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id].binId === bin, [id, bin]);
  const hold = n => up.evaluate(n => window.__read(location.origin + '/#bag/' + n), n);
  await up.goto(base + '#bin/box-u'); await up.waitForSelector('.unpack'); await up.waitForFunction(() => !!window.__reader?.onreading);
  assert.match(await up.textContent('#main'), /Holding a bag’s tag here takes it out the same way\./);
  // where it came from, with Undo, and the box's page stays
  await hold('010'); await until('p-ina', 'b-pwr');
  assert.equal(await up.evaluate(() => location.hash), '#bin/box-u');
  await up.waitForSelector('#toast:has-text("#010 → PWR") button:has-text("Undo")');
  assert.equal((await got('p-ina')).from, '');
  // held again (a sticker read twice): it says where it went, and the box's page stays
  await hold('010'); await up.waitForSelector('#toast:has-text("#010 is in PWR now")');
  assert.equal(await up.evaluate(() => location.hash), '#bin/box-u');
  await hold('010'); await up.waitForSelector('#toast:has-text("#010 is in PWR now")');
  // Undo after a tag puts it back in the box, still from PWR (a new Undo is offered after each move)
  await hold('007'); await until('p-vl5', 'b-env');
  await up.click('#toast button:has-text("Undo")'); await until('p-vl5', 'box-u');
  assert.equal((await got('p-vl5')).from, 'ENV');
  // with a bin picked under Unpack into, a bag's tag sends it there
  await up.selectOption('#unpack-to', 'b-pwr');
  await hold('007'); await until('p-vl5', 'b-pwr');
  await up.waitForSelector('#toast:has-text("#007 → PWR")');
  // a bag with nowhere to go back to, and nothing picked, asks for a bin and stays
  await up.selectOption('#unpack-to', '');
  await hold('012'); await up.waitForSelector('#toast:has-text("#012 has no bin to go back to: choose one under Unpack into")');
  assert.equal((await got('p-zet')).binId, 'box-u'); assert.equal(await up.evaluate(() => location.hash), '#bin/box-u');
  // an old Stockroom tag of a bag in the box takes it out too, and still offers to rewrite it (it offered nothing)
  await up.evaluate(() => window.__read('https://claude.ai/artifact/x#bag/014')); await until('p-old', 'b-pwr');
  await up.waitForSelector('.sheet h3:text("Update this tag?")');
  assert.equal(await up.evaluate(() => location.hash), '#bin/box-u');
  await up.click('.sheet #later'); await up.waitForFunction(() => !document.querySelector('.sheet'));
  // a bag that isn't in this box opens, as a tag does anywhere else
  await hold('020'); await up.waitForFunction(() => location.hash === '#bag/020');
  await up.waitForSelector('.binhead h2:text("Elsewhere")');
  assert.equal((await got('p-out')).binId, 'b-env');
  // and on a bin's page (not a box), a bag's tag opens it
  await up.goto(base + '#bin/b-pwr'); await up.waitForSelector('.binhead');
  await hold('010'); await up.waitForFunction(() => location.hash === '#bag/010');
  assert.equal((await got('p-ina')).binId, 'b-pwr');
  assert.deepEqual(up.problems, []);
  await uCtx.close();
}

// ---- Move on a part's page: the bins moved to lately first, then the rest; a tap, or holding a bin's sticker while it's
// open, moves the bag there with Undo, by the same "came from" rule as Pack and Unpack
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', location: 'Rack A', t: 1 }, 'b-pwr': { code: 'PWR', name: 'Power', t: 1 }, 'b-led': { code: 'LED', name: 'Lights', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', t: 1 } },
    parts: {
      'p-ina': { name: 'INA219', binId: 'b-env', qty: 2, unit: 'pcs', tags: [], bag: 1, tagWritten: true, t: 1 },
      'p-two': { name: 'SCD41', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], bag: 2, tagWritten: true, t: 1 },
    } } });
  const mCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await mCtx.addInitScript(fakeNfc);
  await mCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const mp = await mCtx.newPage();
  mp.problems = []; mp.on('pageerror', e => mp.problems.push(e.message)); mp.on('console', m => { if (m.type() === 'error') mp.problems.push(m.text()); });
  const got = () => mp.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-ina']);
  const until = bin => mp.waitForFunction(bin => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-ina'].binId === bin, bin);
  const closed = () => mp.waitForFunction(() => !document.querySelector('.sheet'));
  const hold = path => mp.evaluate(p => window.__read(location.origin + '/' + p), path);
  await mp.goto(base + '#part/p-ina'); await mp.waitForSelector('#move'); await mp.waitForFunction(() => !!window.__reader?.onreading);
  // nothing moved to lately: every other bin and box, bins first
  await mp.click('#move'); await mp.waitForSelector('.sheet [data-to]');
  assert.equal(await mp.textContent('.sheet h3'), 'Move #001');
  assert.equal(await mp.textContent('.sheet p.muted'), 'In ENV now. Hold the sticker of the bin or box it’s going into, or pick one.');
  assert.deepEqual(await mp.locator('.sheet [data-to]').evaluateAll(b => b.map(x => x.dataset.to)), ['b-led', 'b-pwr', 'box-1']);
  assert.equal(await mp.locator('.sheet details').count(), 0);
  // a tap moves it, with Undo
  await mp.click('.sheet [data-to="b-pwr"]'); await closed(); await until('b-pwr');
  await mp.waitForSelector('#toast:has-text("#001 → PWR") button:has-text("Undo")');
  assert.match(await mp.textContent('.binhead .muted'), /In PWR/);
  await mp.click('#toast button'); await until('b-env');
  await mp.waitForSelector('#toast:has-text("#001 is back where it was")');
  // PWR first now, under Lately, the rest folded away
  await mp.click('#move'); await mp.waitForSelector('.sheet [data-to]');
  assert.equal(await mp.textContent('.sheet .lbl'), 'Lately');
  assert.deepEqual(await mp.locator('.sheet .list').first().locator('[data-to]').evaluateAll(b => b.map(x => x.dataset.to)), ['b-pwr']);
  assert.equal(await mp.textContent('.sheet details summary'), 'Every other bin and box (2)');
  // a bag's sticker held while it's open isn't where it goes; nor is the bin it's in
  await hold('#bag/002'); await mp.waitForSelector('#toast:has-text("That’s bag #002’s tag. Hold a bin’s or box’s.")');
  await hold('#bin/b-env'); await mp.waitForSelector('#toast:has-text("#001 is in ENV already")');
  assert.equal(await mp.locator('.sheet').count(), 1); assert.equal(await mp.evaluate(() => location.hash), '#part/p-ina');
  // a bin's sticker held while it's open moves the bag there, and the page stays on the part
  await hold('#bin/b-led'); await closed(); await until('b-led');
  await mp.waitForSelector('#toast:has-text("#001 → LED")');
  assert.equal(await mp.evaluate(() => location.hash), '#part/p-ina');
  // into a box: it came from the bin it was in; out again: forgotten
  await mp.click('#move'); await mp.click('.sheet details summary'); await mp.click('.sheet [data-to="box-1"]'); await until('box-1');
  assert.equal((await got()).from, 'LED');
  await mp.click('#move'); await mp.waitForSelector('.sheet [data-to]');
  assert.equal(await mp.textContent('.sheet p.muted'), 'In BOX 01 now. Hold the sticker of the bin or box it’s going into, or pick one.');
  await hold('#bin/b-pwr'); await until('b-pwr');
  assert.equal((await got()).from, '');
  // closed (Cancel, or the phone's Back), a bin's sticker opens the bin again
  await mp.click('#move'); await mp.click('.sheet #done'); await closed();
  await hold('#bin/b-env'); await mp.waitForFunction(() => location.hash === '#bin/b-env');
  assert.equal((await got()).binId, 'b-pwr');
  await mp.goto(base + '#part/p-ina'); await mp.click('#move'); await mp.waitForSelector('.sheet [data-to]');
  await mp.evaluate(() => history.back()); await closed();
  await hold('#bin/b-led'); await mp.waitForFunction(() => location.hash === '#bin/b-led');
  assert.equal((await got()).binId, 'b-pwr');
  assert.deepEqual(mp.problems, []);
  await mCtx.close();
}

// ---- Move parts on a bin's page: a tick on each row and a bar, "Move N to [bin or box]", that moves the ticked ones in
// one go with Undo, by the same "came from" rule as Pack and Unpack (splitting a 30-part bin was about 120 taps)
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-big': { code: 'MIX', name: 'Everything', t: 1 }, 'b-pwr': { code: 'PWR', name: 'Power', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', t: 1 } },
    parts: {
      'p-a': { name: 'Buck converter', binId: 'b-big', qty: 3, unit: 'pcs', tags: [], bag: 1, t: 1 },
      'p-b': { name: 'INA219', binId: 'b-big', qty: 2, unit: 'pcs', tags: [], bag: 2, t: 1 },
      'p-c': { name: 'LED strip', binId: 'b-big', qty: 1.5, unit: 'm', tags: [], bag: 3, t: 1 },
      'p-d': { name: 'TP4056', binId: 'b-big', qty: 4, unit: 'pcs', tags: [], bag: 4, t: 1 },
      'p-e': { name: 'Zener diodes', binId: 'b-big', qty: 20, unit: 'pcs', tags: [], t: 1 },
    } } });
  const vCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await vCtx.addInitScript(fakeNfc);
  await vCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const vp = await vCtx.newPage();
  vp.problems = []; vp.on('pageerror', e => vp.problems.push(e.message)); vp.on('console', m => { if (m.type() === 'error') vp.problems.push(m.text()); });
  const parts = () => vp.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts);
  const where = async () => Object.fromEntries(Object.entries(await parts()).map(([k, x]) => [k, x.binId]));
  await vp.goto(base + '#bin/b-big'); await vp.click('#moveparts'); await vp.waitForSelector('.movelist');
  assert.equal(await vp.locator('#moveparts').count(), 0);
  assert.equal(await vp.textContent('#mv-n'), 'Move 0 to'); assert.equal(await vp.isDisabled('#mv-go'), true);
  await vp.check('.movelist input[data-id="p-a"]'); await vp.check('.movelist input[data-id="p-b"]'); await vp.check('.movelist input[data-id="p-d"]');
  assert.equal(await vp.textContent('#mv-n'), 'Move 3 to'); assert.equal(await vp.isDisabled('#mv-go'), true, 'nowhere picked yet');
  assert.equal(await vp.getAttribute('#mv-to', 'id'), 'mv-to');
  assert.deepEqual(await vp.locator('#mv-to option').evaluateAll(o => o.map(x => x.value)), ['', 'b-pwr', 'box-1']);
  await vp.selectOption('#mv-to', 'b-pwr'); await vp.click('#mv-go');
  await vp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-d'].binId === 'b-pwr');
  assert.deepEqual(await where(), { 'p-a': 'b-pwr', 'p-b': 'b-pwr', 'p-c': 'b-big', 'p-d': 'b-pwr', 'p-e': 'b-big' });
  await vp.waitForSelector('#toast:has-text("3 parts moved to PWR") button:has-text("Undo")');
  // the page is the bin again, with what's left in it
  await vp.waitForSelector('#moveparts'); assert.equal(await vp.locator('.movelist').count(), 0);
  assert.deepEqual(await vp.locator('#main .list .item .t').allTextContents(), ['LED strip', 'Zener diodes']);
  // Undo puts all three back
  await vp.click('#toast button'); await vp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-a'].binId === 'b-big');
  await vp.waitForSelector('#toast:has-text("3 parts are back where they were")');
  assert.deepEqual(Object.values(await where()), ['b-big', 'b-big', 'b-big', 'b-big', 'b-big']);
  // All ticks every row; into a box, each remembers it came from MIX; PWR is listed first now, as lately used
  await vp.click('#moveparts'); await vp.check('#mv-all');
  assert.equal(await vp.textContent('#mv-n'), 'Move 5 to');
  assert.deepEqual(await vp.locator('#mv-to optgroup').evaluateAll(o => o.map(x => x.label)), ['Lately', 'Every other']);
  await vp.selectOption('#mv-to', 'box-1'); await vp.click('#mv-go');
  await vp.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.parts).every(x => x.binId === 'box-1'));
  assert.deepEqual(Object.values(await parts()).map(x => x.from), ['MIX', 'MIX', 'MIX', 'MIX', 'MIX']);
  await vp.waitForSelector('text=Nothing in this bin yet.');
  // out of the box again from its page: where they came from is forgotten, as when they're unpacked
  await vp.goto(base + '#bin/box-1'); await vp.click('#moveparts'); await vp.waitForSelector('.movelist');
  assert.equal(await vp.locator('#unpack-to').count(), 0, 'the unpacking bar under the ticks');
  await vp.check('.movelist input[data-id="p-c"]'); await vp.selectOption('#mv-to', 'b-pwr'); await vp.click('#mv-go');
  await vp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-c'].binId === 'b-pwr');
  assert.equal((await parts())['p-c'].from, '');
  // ticks stay while the page is drawn again, and Cancel, or another screen, leaves them
  await vp.click('#moveparts'); await vp.check('.movelist input[data-id="p-a"]');
  await vp.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  await vp.waitForTimeout(200); assert.equal(await vp.isChecked('.movelist input[data-id="p-a"]'), true);
  await vp.click('#mv-cancel'); await vp.waitForSelector('#moveparts'); assert.equal(await vp.locator('.movelist').count(), 0);
  await vp.click('#moveparts'); await vp.goto(base + '#bins'); await vp.goto(base + '#bin/box-1'); await vp.waitForSelector('#moveparts');
  assert.equal(await vp.locator('.movelist').count(), 0);
  assert.deepEqual(vp.problems, []);
  await vCtx.close();
}

// ---- Copy as new part from Pack's sheet is one more bag packed: Next bag after its tag, listed under "Packed into … just
// now", and the field emptied for the next one
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-pas': { code: 'PAS', name: 'Passives', t: 1 } },
    parts: { 'p-10k': { name: 'Resistor 10k', binId: 'b-pas', category: 'Resistors', qty: 50, unit: 'pcs', tags: [], bag: 1, tagWritten: true, t: 1 } } } });
  const qCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await qCtx.addInitScript(fakeNfc);
  await qCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) { localStorage.setItem('parts-bin', d); localStorage.setItem('sr.packbox', '"b-pas"'); } }, seed);
  const qp = await qCtx.newPage();
  qp.problems = []; qp.on('pageerror', e => qp.problems.push(e.message)); qp.on('console', m => { if (m.type() === 'error') qp.problems.push(m.text()); });
  await qp.goto(base + '#scan'); await qp.waitForSelector('#desc');
  await qp.fill('#desc', 'resistor 10k'); await qp.press('#desc', 'Enter'); await qp.waitForSelector('.sheet #copyp');
  await qp.click('.sheet #copyp'); await qp.waitForSelector('.sheet h3:text("New part")');
  await qp.fill('#p-name', 'Resistor 4.7k'); await qp.click('.sheet #save'); await qp.waitForSelector('#tz.wait');
  assert.equal(await qp.textContent('.sheet #done'), 'Skip the tag');
  await qp.evaluate(() => window.__tap()); await qp.waitForFunction(() => document.querySelector('.sheet #done')?.textContent === 'Next bag');
  await qp.waitForFunction(() => !document.querySelector('.sheet'));
  await qp.waitForSelector('.packed');
  assert.deepEqual(await qp.locator('.packed .item .t').allTextContents(), ['Resistor 4.7k']);
  assert.equal(await qp.inputValue('#desc'), '');
  assert.equal(await qp.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-10k'].qty), 50, 'the part copied changed');
  assert.deepEqual(qp.problems, []);
  await qCtx.close();
}

// ---- on a phone a bin's tile is its label, count and name, about 70 px tall (the empty picture box made it 220 px, two
// rows of bins to a screen); on a laptop it keeps its picture box
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental sensors and breakouts', location: 'Workroom', t: 1 }, 'b-pwr': { code: 'PWR', name: 'Power', location: 'Workroom', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', sealed: true, t: 1 }, 'b-grid': { code: 'GRIDFINITY-A12', name: 'Small stuff', location: 'Shed', t: 1 } },
    parts: { 'p-a': { name: 'SHT31', binId: 'b-env', qty: 1, minQty: 2, unit: 'pcs', tags: [], t: 1 }, 'p-g': { name: 'Header pins', binId: 'b-grid', qty: 1, minQty: 2, unit: 'pcs', tags: [], t: 1 } } } });
  for (const [w, hgt, phone] of [[390, 844, true], [1280, 800, false]]) {
    const tCtx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
    await tCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
    const tp = await tCtx.newPage();
    await tp.goto(base + '#bins'); await tp.waitForSelector('.bin');
    const tiles = await tp.locator('.bin').evaluateAll(els => els.map(e => ({ h: e.getBoundingClientRect().height, w: e.scrollWidth - e.clientWidth, photo: getComputedStyle(e.querySelector('.photo')).display !== 'none', text: e.innerText.replace(/\s+/g, ' ').trim() })));
    assert.equal(tiles.length, 4);
    for (const t of tiles) {
      assert.equal(t.photo, !phone, t.text);
      if (phone) assert.ok(t.h <= (t.text.startsWith('GRIDFINITY') ? 100 : 80), `${t.text}: ${t.h} px`); else assert.ok(t.h > 150, `${t.text}: ${t.h} px`);
      assert.equal(t.w, 0, 'nothing runs out of the tile: ' + t.text);
    }
    // a long label code puts the count under it, each count on one line, rather than squeezing "1 part" a word to a line
    // under the label
    const grid = await tp.locator('.bin:has-text("GRIDFINITY")').evaluate(e => { const l = e.querySelector('.label').getBoundingClientRect(), m = e.querySelector('.meta').getBoundingClientRect();
      return { apart: l.right <= m.left || l.bottom <= m.top, lines: [...e.querySelectorAll('.meta span')].map(s => s.getClientRects().length) }; });
    assert.ok(grid.apart, 'the label and the count overlap'); assert.deepEqual(grid.lines, [1, 1]);
    if (phone) { // two to a row, as before
      const xs = await tp.locator('.bins:has-text("PWR") .bin').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
      assert.equal(xs[0], xs[1]);
    }
    await tCtx.close();
  }
}

// ---- Parts' Show menu: the lists first, each with how many parts are on it, then the categories; Bag tag not written
// lists the bags with no sticker yet in bag order (a tag that failed and was skipped left a numbered bag nothing found
// again), and such a part's page says so
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 } },
    parts: {
      'p-a': { name: 'SHT31', binId: 'b-env', category: 'Sensors', qty: 1, minQty: 2, unit: 'pcs', tags: [], bag: 7, t: 1 },
      'p-b': { name: 'BME280', binId: 'b-env', category: 'Sensors', qty: 4, unit: 'pcs', tags: [], bag: 3, tagWritten: true, check: 'Is it a BMP280?', t: 1 },
      'p-c': { name: 'Buck converter', binId: 'b-env', category: 'Power', qty: 2, unit: 'pcs', tags: [], bag: 2, t: 1 },
      'p-d': { name: 'Zener diodes', category: 'Passives', qty: 20, unit: 'pcs', tags: [], t: 1 },
    } } });
  const sCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await sCtx.addInitScript(fakeNfc);
  await sCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const sp = await sCtx.newPage();
  sp.problems = []; sp.on('pageerror', e => sp.problems.push(e.message)); sp.on('console', m => { if (m.type() === 'error') sp.problems.push(m.text()); });
  await sp.goto(base + '#parts'); await sp.waitForSelector('#cat');
  assert.equal(await sp.getAttribute('#cat', 'aria-label'), 'Show');
  const menu = () => sp.locator('#cat').evaluate(s => [...s.children].map(c => c.tagName === 'OPTGROUP' ? [c.label, [...c.children].map(o => o.textContent)] : c.textContent));
  assert.deepEqual(await menu(), ['All parts (4)',
    ['Lists', ['Low stock (1)', 'Out of stock (0)', 'To check (1)', 'Bag tag not written (2)', 'Recently changed (0)', 'Not yet bagged (1)', 'Not in a bin (1)', 'Bagged (3)', 'Bag numbers to sort out (0)']],
    ['Categories', ['Passives (1)', 'Power (1)', 'Sensors (2)']]]);
  await sp.selectOption('#cat', '__untagged');
  assert.deepEqual(await sp.locator('.item .t').allTextContents(), ['Buck converter', 'SHT31'], 'in bag order');
  // the counts follow the inventory: the tag written for bag #002 takes it off the list
  await sp.click('.item:has-text("Buck converter")'); await sp.waitForSelector('#notag');
  assert.equal(await sp.textContent('#notag'), 'No tag on this bag yet');
  await sp.click('#bagtag'); await sp.click('.sheet #write'); await sp.waitForSelector('#tz.wait'); await sp.evaluate(() => window.__tap());
  await sp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-c'].tagWritten === true);
  await sp.waitForFunction(() => !document.querySelector('.sheet'));
  await sp.waitForFunction(() => !document.getElementById('notag'));
  await sp.goto(base + '#parts'); await sp.waitForSelector('#cat');
  assert.equal(await sp.inputValue('#cat'), '__untagged', 'the list picked stays picked');
  assert.deepEqual(await sp.locator('.item .t').allTextContents(), ['SHT31']);
  assert.equal(await sp.locator('#cat option[value="__untagged"]').textContent(), 'Bag tag not written (1)');
  // a part with no bag, or one whose tag is written, says nothing about a tag
  for (const id of ['p-b', 'p-d']) { await sp.goto(base + '#part/' + id); await sp.waitForSelector('.binhead h2'); assert.equal(await sp.locator('#notag').count(), 0, id); }
  // a category no part has any more shows all parts, not an empty list under a menu that says otherwise
  await sp.evaluate(() => localStorage.setItem('sr.cat', '"Motors"'));
  await sp.goto(base + '#parts'); await sp.waitForSelector('#cat');
  assert.equal(await sp.inputValue('#cat'), ''); assert.equal(await sp.locator('.item').count(), 4);
  // nothing on a list says which list, without its count, and offers all parts
  await sp.selectOption('#cat', '__check'); await sp.fill('#q', 'zzz');
  await sp.waitForSelector('#main .empty:has-text("Nothing in “To check” matches “zzz”.")');
  assert.equal(await sp.textContent('#main .empty #allcats'), 'Show all parts');
  assert.deepEqual(sp.problems, []);
  await sCtx.close();
}

// ---- low stock on a phone: a Low stock row on Bins naming the first three, opening Parts › Low stock; a box's tile counts
// its low parts as a bin's does (a low part packed for a move showed up nowhere on Bins); Low stock copies a reorder list,
// and parts used up with no reorder level have a list of their own, Out of stock
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 }, 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', t: 1 } },
    parts: {
      'p-a': { name: 'SHT31 humidity breakout', binId: 'b-env', qty: 1, minQty: 2, unit: 'pcs', mpn: 'SHT31-DIS', link: 'https://shop.test/sht31', tags: [], t: 1 },
      'p-b': { name: 'BME280', binId: 'box-1', qty: 0, minQty: 1, unit: 'pcs', tags: [], t: 1 },
      'p-c': { name: 'Solder wire', binId: 'b-env', qty: 0.5, minQty: 1, unit: 'm', tags: [], t: 1 },
      'p-d': { name: 'Zener diodes', binId: 'b-env', qty: 20, minQty: 5, unit: 'pcs', tags: [], t: 1 },
      'p-e': { name: 'Buzzer', binId: 'b-env', qty: 0, unit: 'pcs', tags: [], t: 1 },
      'p-f': { name: 'Header pins', qty: 2, minQty: 4, unit: 'pcs', tags: [], t: 1 },
    } } });
  const lCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await lCtx.addInitScript(fakeNfc);
  await lCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const lp = await lCtx.newPage();
  lp.problems = []; lp.on('pageerror', e => lp.problems.push(e.message)); lp.on('console', m => { if (m.type() === 'error') lp.problems.push(m.text()); });
  await lp.goto(base + '#bins'); await lp.waitForSelector('#lowrow');
  assert.equal(await lp.textContent('.bin:has-text("BOX 01") .meta'), '1 bag1 low');
  assert.equal(await lp.textContent('.bin:has-text("ENV") .meta'), '4 parts2 low');
  const heads = await lp.locator('#main .section-h h3').allTextContents();
  assert.deepEqual(heads.slice(-2), ['Not in a bin', 'Low stock'], 'under Not in a bin');
  assert.equal(await lp.textContent('#lowrow .t'), 'BME280, Header pins, SHT31 humidity breakout, …');
  assert.equal((await lp.textContent('#lowrow .q')).replace(/\s+/g, ' '), '4low');
  await lp.click('#lowrow'); await lp.waitForSelector('#reorder');
  assert.equal(await lp.inputValue('#cat'), '__low');
  assert.deepEqual(await lp.locator('.item .t').allTextContents(), ['BME280', 'Header pins', 'SHT31 humidity breakout', 'Solder wire']);
  await lp.click('#reorder'); await lp.waitForSelector('#toast:has-text("Reorder list copied: 4 parts")');
  assert.equal(await lp.evaluate(() => window.__shared), ['BME280: 0 left, reorder at 1', 'Header pins: 2 left, reorder at 4',
    'SHT31 humidity breakout: 1 left, reorder at 2 · SHT31-DIS · https://shop.test/sht31', 'Solder wire: 0.5 m left, reorder at 1 m'].join('\n'));
  // a search narrows what's copied to what's shown
  await lp.fill('#q', 'sht31'); await lp.waitForFunction(() => document.querySelectorAll('.item').length === 1);
  await lp.click('#reorder'); await lp.waitForSelector('#toast:has-text("Reorder list copied: 1 part")');
  assert.equal(await lp.evaluate(() => window.__shared), 'SHT31 humidity breakout: 1 left, reorder at 2 · SHT31-DIS · https://shop.test/sht31');
  await lp.fill('#q', ''); await lp.waitForFunction(() => document.querySelectorAll('.item').length === 4);
  // used up with no reorder level: out of stock, not low
  assert.equal(await lp.locator('#cat option[value="__out"]').textContent(), 'Out of stock (1)');
  await lp.selectOption('#cat', '__out'); await lp.waitForFunction(() => !document.getElementById('reorder'));
  assert.deepEqual(await lp.locator('.item .t').allTextContents(), ['Buzzer']);
  // nothing low: no row on Bins
  await lp.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); for (const x of Object.values(d.items.parts)) delete x.minQty; localStorage.setItem('parts-bin', JSON.stringify(d)); });
  await lp.goto(base + '#bins'); await lp.reload(); await lp.waitForSelector('.bin');
  assert.equal(await lp.locator('#lowrow').count(), 0); assert.equal(await lp.textContent('.bin:has-text("BOX 01") .meta'), '1 bag');
  assert.deepEqual(lp.problems, []);
  await lCtx.close();
}

// ---- a part's page says when it was last changed, and Parts › Recently changed lists the parts changed in the last 7
// days, newest first (what a Pack session or an Inbox batch touched)
{
  const now = Date.now(), day = 864e5;
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 } },
    parts: {
      'p-a': { name: 'SHT31', binId: 'b-env', qty: 1, unit: 'pcs', tags: [], t: now - 3 * day },
      'p-b': { name: 'BME280', binId: 'b-env', qty: 4, unit: 'pcs', tags: [], t: now - 1 * day },
      'p-c': { name: 'Buck converter', binId: 'b-env', qty: 2, unit: 'pcs', tags: [], t: now - 10 * day },
      'p-d': { name: 'Zener diodes', qty: 20, unit: 'pcs', tags: [], t: 1 },
      'p-e': { name: 'Old one', qty: 1, unit: 'pcs', tags: [], t: Date.UTC(2024, 4, 7, 12) },
    } } });
  const rCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await rCtx.addInitScript(fakeNfc);
  await rCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const rp = await rCtx.newPage();
  rp.problems = []; rp.on('pageerror', e => rp.problems.push(e.message)); rp.on('console', m => { if (m.type() === 'error') rp.problems.push(m.text()); });
  await rp.goto(base + '#parts'); await rp.waitForSelector('#cat');
  assert.equal(await rp.locator('#cat option[value="__recent"]').textContent(), 'Recently changed (2)');
  await rp.selectOption('#cat', '__recent');
  assert.deepEqual(await rp.locator('.item .t').allTextContents(), ['BME280', 'SHT31'], 'newest first; ten days ago is out');
  // a change moves it to the top, and puts a part changed long ago on the list
  await rp.click('.item:has-text("SHT31")'); await rp.waitForSelector('#changed');
  assert.equal(await rp.textContent('#changed'), 'Last changed ' + await rp.evaluate(t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), now - 3 * day));
  await rp.click('#inc'); await rp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-a'].qty === 2);
  await rp.waitForFunction(t => document.getElementById('changed').textContent === 'Last changed ' + t, await rp.evaluate(() => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
  await rp.goto(base + '#part/p-c'); await rp.click('#inc'); await rp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-c'].qty === 3);
  await rp.goto(base + '#parts'); await rp.waitForSelector('#cat');
  assert.deepEqual(await rp.locator('.item .t').allTextContents(), ['Buck converter', 'SHT31', 'BME280']);
  // another year says the year; a part with no time saved says nothing
  await rp.goto(base + '#part/p-e'); await rp.waitForSelector('#changed');
  assert.equal(await rp.textContent('#changed'), 'Last changed ' + await rp.evaluate(() => new Date(Date.UTC(2024, 4, 7, 12)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })));
  assert.match(await rp.textContent('#changed'), /2024/);
  await rp.goto(base + '#part/p-d'); await rp.waitForSelector('.binhead h2'); assert.equal(await rp.locator('#changed').count(), 0);
  assert.deepEqual(rp.problems, []);
  await rCtx.close();
}

// ---- Settings saves the inventory as a spreadsheet: one row a part, by bin and bag, opening in Excel with Ω as typed and
// a formula shown as text (the only way out was the backup file's JSON)
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', t: 1 }, 'b-pas': { code: 'PAS', name: 'Passives', t: 1 } },
    parts: {
      'p-a': { name: 'Resistor 4.7kΩ', binId: 'b-pas', qty: 100, unit: 'pcs', bag: 3, tags: [], t: 1 },
      'p-b': { name: 'SCD41 CO₂ sensor', binId: 'b-env', qty: 2, unit: 'pcs', bag: 9, tags: ['i2c'], notes: '=1+1', t: 1 },
      'p-c': { name: 'BME280', binId: 'b-env', qty: 4, unit: 'pcs', bag: 1, tags: [], t: 1 },
    } } });
  const cCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, serviceWorkers: 'block' });
  await cCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const cp = await cCtx.newPage();
  await cp.goto(base + '#settings'); await cp.waitForSelector('#csv');
  assert.equal(await cp.textContent('#csv'), 'Save as a spreadsheet (CSV)');
  assert.match(await cp.textContent('#csv'), /CSV/); assert.match(await cp.locator('section:has(#csv)').textContent(), /Only the backup file loads back in\./);
  const [dl] = await Promise.all([cp.waitForEvent('download'), cp.click('#csv')]);
  assert.match(dl.suggestedFilename(), /^parts-bin-\d{4}-\d\d-\d\d\.csv$/);
  await cp.waitForSelector(`#toast:has-text("Spreadsheet saved: ${dl.suggestedFilename()}, 3 parts")`);
  const text = await readFile(await dl.path(), 'utf8');
  assert.ok(text.startsWith('﻿"Bin","Bin name","Bag","Name"'));
  const lines = text.slice(1).trim().split('\r\n');
  assert.deepEqual(lines.slice(1).map(l => l.split('","')[3]), ['BME280', 'SCD41 CO₂ sensor', 'Resistor 4.7kΩ'], 'ENV before PAS, then bag order');
  assert.ok(lines[2].includes('"\'=1+1"'), 'the note is text, not a formula');
  // the page itself is unchanged by it
  assert.equal(await cp.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('parts-bin')).items.parts).length), 3);
  await cCtx.close();
}

// ---- Undo after deleting a part or a bin: the part comes back exactly as it was (its bag's tag opens it again), and a bin
// comes back with its parts in it, except one moved somewhere else since (a mis-tapped delete could only be got back from
// a backup file)
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'b-env': { code: 'ENV', name: 'Environmental', location: 'Workroom', tagWritten: true, t: 1 }, 'b-pwr': { code: 'PWR', name: 'Power', t: 1 } },
    parts: {
      'p-a': { name: 'BME280 (Adafruit)', binId: 'b-env', category: 'Sensors', qty: 5, minQty: 2, unit: 'pcs', bag: 3, tagWritten: true, tags: ['i2c'], iface: ['I2C'], addr: '0x77', notes: 'Two have bent pins', t: 1 },
      'p-b': { name: 'SCD41', binId: 'b-env', qty: 3, unit: 'pcs', tags: [], bag: 4, t: 1 },
      'p-c': { name: 'Buck converter', binId: 'b-pwr', qty: 2, unit: 'pcs', tags: [], t: 1 },
    } } });
  const uCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await uCtx.addInitScript(fakeNfc);
  await uCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const up = await uCtx.newPage();
  up.problems = []; up.on('pageerror', e => up.problems.push(e.message)); up.on('console', m => { if (m.type() === 'error') up.problems.push(m.text()); });
  up.on('dialog', d => d.accept());
  const items = () => up.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items);
  const body = x => { const { t, ...rest } = x; return rest; };
  const before = (await (async () => { await up.goto(base + '#bins'); await up.waitForSelector('.bin'); return items(); })());
  // a part
  await up.goto(base + '#part/p-a'); await up.click('#edit'); await up.click('.sheet #del');
  await up.waitForSelector('#toast:has-text("Deleted BME280 (Adafruit)") button:has-text("Undo")'); await up.waitForFunction(() => location.hash === '#parts');
  assert.ok((await items()).parts['p-a'].del, 'deleted');
  await up.click('#toast button'); await up.waitForSelector('#toast:has-text("BME280 (Adafruit) is back")');
  const back = (await items()).parts['p-a'];
  assert.deepEqual(body(back), body(before.parts['p-a']), 'exactly as it was');
  assert.ok(back.t > before.parts['p-a'].t, 'saved as a change, so it wins over the deletion on every device');
  await up.waitForSelector('.item:has-text("BME280 (Adafruit)")');
  await up.evaluate(() => window.__read(location.origin + '/#bag/003')); await up.waitForSelector('.binhead h2:has-text("BME280 (Adafruit)")');
  // a bin: its parts come back in it, but not one moved to another bin in the meantime
  await up.goto(base + '#bin/b-env'); await up.click('#edit'); await up.click('.sheet #del');
  await up.waitForSelector('#toast:has-text("Deleted bin ENV") button:has-text("Undo")'); await up.waitForFunction(() => location.hash === '#bins');
  assert.deepEqual([(await items()).parts['p-a'].binId, (await items()).parts['p-b'].binId], ['', '']);
  await up.evaluate(async () => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts['p-b'].binId = 'b-pwr'; d.items.parts['p-b'].t += 1; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await up.waitForFunction(() => document.querySelector('.bin:has(.label:not(.box))')?.textContent.includes('PWR') && document.querySelector('.bins').textContent.includes('2 parts'));
  await up.click('#toast button'); await up.waitForSelector('#toast:has-text("Bin ENV is back, with its part")');
  const after = await items();
  assert.deepEqual(body(after.bins['b-env']), body(before.bins['b-env']), 'the bin as it was, tag and all');
  assert.equal(after.parts['p-a'].binId, 'b-env'); assert.equal(after.parts['p-b'].binId, 'b-pwr', 'moved since: left where it went');
  await up.waitForSelector('.bin:has-text("ENV")');
  // Undo on a part that's back already (a sync brought it) leaves it as it is
  await up.goto(base + '#part/p-c'); await up.click('#edit'); await up.click('.sheet #del');
  await up.waitForSelector('#toast:has-text("Deleted Buck converter") button');
  await up.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts['p-c'] = { name: 'Buck converter', binId: 'b-pwr', qty: 9, unit: 'pcs', t: d.items.parts['p-c'].del + 1 }; localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await up.waitForSelector('.item:has-text("Buck converter")');
  await up.click('#toast button'); await up.waitForSelector('#toast:has-text("Buck converter is back already")');
  assert.equal((await items()).parts['p-c'].qty, 9);
  assert.deepEqual(up.problems, []);
  await uCtx.close();
}

// ---- Undo on an Inbox Skip: the card comes back where it was, with a field unticked on it still unticked and the
// keyboard on it; the last card of a batch, whose Skip finished the batch, brings the batch back (a mis-tapped Skip, beside
// Apply on a small card, was gone unless Claude was asked for the batch again)
{
  const INX = await import(join(root, 'js/inbox.js'));
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: {},
    parts: { 'p-bh': { name: 'BH1750', category: 'Light', qty: 2, unit: 'pcs', tags: [], t: 1 }, 'p-ss': { name: 'SSD1306', qty: 1, unit: 'pcs', tags: [], t: 1 } } } });
  const kCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await kCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const kp = await kCtx.newPage();
  kp.problems = []; kp.on('pageerror', e => kp.problems.push(e.message)); kp.on('console', m => { if (m.type() === 'error') kp.problems.push(m.text()); });
  await kp.goto(base + '#' + await INX.encode({ partsbin: 1, batch: { id: 'ptest-undo', name: 'Bench', source: 'details', items: [
    { name: 'Rotary encoder', qty: 4 }, { id: 'p-bh', category: 'Sensors', addr: '0x23' }, { id: 'p-ss', iface: ['I2C'] }] } }));
  await kp.waitForSelector('.card.inb[data-k="i2"]');
  const cards = () => kp.locator('.card.inb').evaluateAll(cs => cs.map(c => c.dataset.k));
  const saved = () => kp.evaluate(() => JSON.parse(localStorage.getItem('parts-bin.inbox')));
  // a suggestion with one field unticked
  await kp.uncheck('.card.inb[data-k="i1"] .diff input[data-k="addr"]');
  await kp.click('.card.inb[data-k="i1"] [data-a="skip"]'); await kp.waitForFunction(() => !document.querySelector('.card.inb[data-k="i1"]'));
  await kp.waitForSelector('#toast:has-text("Skipped BH1750") button:has-text("Undo")');
  await kp.click('#toast button'); await kp.waitForSelector('.card.inb[data-k="i1"]');
  assert.deepEqual(await cards(), ['i0', 'i1', 'i2'], 'back in its place');
  await kp.waitForSelector('#toast:has-text("BH1750 is back in the Inbox")');
  assert.equal(await kp.isChecked('.card.inb[data-k="i1"] .diff input[data-k="addr"]'), false, 'still unticked');
  assert.equal(await kp.isChecked('.card.inb[data-k="i1"] .diff input[data-k="category"]'), true);
  assert.equal(await kp.evaluate(() => document.activeElement.closest('.card.inb')?.dataset.k), 'i1', 'the keyboard is on it');
  assert.deepEqual((await saved()).batches[0].items.map(x => x.k), ['i0', 'i1', 'i2'], 'saved, so a reload keeps it');
  assert.equal(await kp.textContent('#tabbar .badge'), '3');
  // skip all three; the last one's Skip finishes the batch, and its Undo brings it back with that one card
  for (const k of ['i0', 'i1', 'i2']) { await kp.click(`.card.inb[data-k="${k}"] [data-a="skip"]`); await kp.waitForFunction(k => !document.querySelector(`.card.inb[data-k="${k}"]`), k); }
  await kp.waitForSelector('#toast:has-text("“Bench” done: 3 skipped") button:has-text("Undo")');
  assert.equal((await saved()).batches.length, 0); assert.ok('ptest-undo' in (await saved()).seen);
  await kp.click('#toast button'); await kp.waitForSelector('.card.inb[data-k="i2"]');
  assert.deepEqual(await cards(), ['i2']); assert.equal((await saved()).batches[0].id, 'ptest-undo'); assert.ok(!('ptest-undo' in (await saved()).seen));
  assert.equal(await kp.textContent('.batch .section-h .tiny'), 'Suggested details · 1 left');
  // and the batch, finished again, still counts all three
  await kp.click('.card.inb[data-k="i2"] [data-a="skip"]'); await kp.waitForSelector('#toast:has-text("“Bench” done: 3 skipped")');
  assert.deepEqual(kp.problems, []);
  await kCtx.close();
}

// ---- Parts with no details go to Claude 40 at a time, a category's together, and this browser notes which have gone
// (one button sent every bare part at once: with a big inventory, more than Claude's reply could carry in links)
{
  const parts = {};
  for (let i = 1; i <= 30; i++) parts['p-s' + i] = { name: 'Sensor ' + i, category: 'Sensors', qty: 1, unit: 'pcs', tags: [], t: 1 };
  for (let i = 1; i <= 10; i++) parts['p-d' + i] = { name: 'Display ' + i, category: 'Displays', qty: 1, unit: 'pcs', tags: [], t: 1 };
  for (let i = 1; i <= 5; i++) parts['p-n' + i] = { name: 'Thing ' + i, qty: 1, unit: 'pcs', tags: [], t: 1 };
  parts['p-full'] = { name: 'BME280', category: 'Sensors', mpn: 'BME280', qty: 1, unit: 'pcs', tags: [], t: 1 };
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: {}, parts } });
  const cCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await cCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  await cCtx.addInitScript(fakeNfc);
  const cp = await cCtx.newPage();
  cp.problems = []; cp.on('pageerror', e => cp.problems.push(e.message));
  await cp.goto(base + '#inbox');
  await cp.waitForSelector('#inb-share');
  assert.equal(await cp.textContent('#inb-share'), 'Send Claude the next 40 of 45 with no details');
  assert.equal(await cp.locator('#inb-sent').count(), 0);
  const sentList = async () => JSON.parse((await cp.evaluate(() => window.__shared)).split('\n\n')[1]).parts.map(p => p.name);
  await cp.click('#inb-share'); await cp.waitForSelector('#inb-sent');
  const first = await sentList();
  assert.equal(first.length, 40);
  assert.deepEqual(first.slice(0, 11), ['Display 1', 'Display 2', 'Display 3', 'Display 4', 'Display 5', 'Display 6', 'Display 7', 'Display 8', 'Display 9', 'Display 10', 'Sensor 1'], 'a category together, in name order');
  assert.ok(!first.includes('BME280') && !first.some(n => n.startsWith('Thing')), 'parts with no category come last');
  assert.equal(await cp.textContent('#inb-sent'), 'Sent 40 · 5 to go');
  assert.equal(await cp.textContent('#inb-share'), 'Send Claude the next 5 of 45 with no details');
  await cp.reload(); await cp.waitForSelector('#inb-sent');
  assert.equal(await cp.textContent('#inb-sent'), 'Sent 40 · 5 to go', 'kept in this browser');
  await cp.click('#inb-share'); await cp.waitForFunction(() => document.querySelector('#inb-sent')?.textContent === 'Sent all 45');
  assert.deepEqual(await sentList(), ['Thing 1', 'Thing 2', 'Thing 3', 'Thing 4', 'Thing 5']);
  assert.equal(await cp.locator('#inb-share').count(), 0);
  // a part that gets its details drops off the list, and Start again sends from the first again
  await cp.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts['p-d1'].mpn = 'ST7789'; d.items.parts['p-d1'].t = 2; localStorage.setItem('parts-bin', JSON.stringify(d)); });
  await cp.reload(); await cp.waitForSelector('#inb-sent');
  assert.equal(await cp.textContent('#inb-sent'), 'Sent all 44');
  await cp.click('#inb-again'); await cp.waitForSelector('#inb-share');
  assert.equal(await cp.textContent('#inb-share'), 'Send Claude the next 40 of 44 with no details');
  assert.equal(await cp.locator('#inb-sent').count(), 0);
  // a small inventory sends its few as before
  await cp.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); for (const id of Object.keys(d.items.parts)) if (!['p-s1', 'p-s2', 'p-full'].includes(id)) delete d.items.parts[id]; localStorage.setItem('parts-bin', JSON.stringify(d)); localStorage.removeItem('pb.sentbare'); });
  await cp.reload(); await cp.waitForSelector('#inb-share');
  assert.equal(await cp.textContent('#inb-share'), 'Send Claude 2 parts with no details');
  await cp.click('#inb-share'); await cp.waitForSelector('#inb-sent');
  assert.equal(await cp.textContent('#inb-sent'), 'Sent all 2');
  assert.deepEqual(cp.problems, []);
  await cCtx.close();
}
// ---- holding the wrong sticker while a tag is written: the sheet says whose sticker it is before offering to write over
// it (it said only "already holds something", and one tap made bag #011's sticker open #012); a tag held while another
// sheet is open says to close it (it did nothing)
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'box-1': { code: 'BOX 01', kind: 'box', name: 'Bench', location: 'Moving boxes', t: 1 } },
    parts: {
      'p-11': { name: 'Thing 0', binId: 'box-1', qty: 1, unit: 'pcs', tags: [], bag: 11, tagWritten: true, t: 1 },
      'p-12': { name: 'Thing 1', binId: 'box-1', qty: 1, unit: 'pcs', tags: [], bag: 12, t: 1 },
    } } });
  const sCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await sCtx.addInitScript(fakeNfc);
  await sCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const sp = await sCtx.newPage();
  sp.problems = []; sp.on('pageerror', e => sp.problems.push(e.message)); sp.on('console', m => { if (m.type() === 'error') sp.problems.push(m.text()); });
  await sp.goto(base + '#part/p-12'); await sp.waitForFunction(() => !!window.__reader);
  await sp.click('#bagtag'); await sp.click('.sheet #write'); await sp.waitForSelector('#tz.wait');
  // bag #011's sticker held up by mistake: Chrome reads it, then refuses the write
  await sp.evaluate(url => window.__read(url), base + '#bag/011');
  assert.equal(await sp.evaluate(() => location.hash), '#part/p-12', 'reading it left the tag sheet');
  await sp.evaluate(() => window.__fail('NotAllowedError', 'The NFC tag already has data.'));
  await sp.waitForSelector('#tz.bad');
  assert.equal(await sp.textContent('#t-status'), 'That’s bag #011’s sticker (Thing 0, BOX 01). Hold a blank one. Writing over it makes #011’s sticker open #012.');
  assert.equal((await sp.textContent('.sheet #write')).trim(), 'Write over #011’s sticker');
  assert.equal(await sp.locator('.sheet #write svg').count(), 1, 'the button lost its icon');
  // a sticker that holds something, with no reading of it: what writing over it would do
  await sp.click('.sheet #done'); await sp.waitForFunction(() => !document.querySelector('.sheet'));
  await sp.click('#bagtag'); await sp.click('.sheet #write'); await sp.waitForSelector('#tz.wait');
  await sp.evaluate(() => window.__fail('NotAllowedError', 'The NFC tag already has data.'));
  await sp.waitForSelector('#tz.bad');
  assert.equal(await sp.textContent('#t-status'), 'That sticker already holds a link. If it’s on another bag, use a blank one: writing over it makes that bag’s sticker open this one.');
  assert.equal((await sp.textContent('.sheet #write')).trim(), 'Write over it'); assert.equal(await sp.locator('.sheet #write svg').count(), 1);
  await sp.click('.sheet #write'); await sp.waitForSelector('#tz.wait');
  assert.ok(await sp.evaluate(() => window.__tap())); await sp.waitForSelector('#tz.ok');
  await sp.waitForFunction(() => !document.querySelector('.sheet'));
  // a tag held while the Edit sheet is open says to close it, and stays where it is
  await sp.waitForTimeout(3100); // a tag read straight after one is written is that tag
  await sp.click('#edit'); await sp.waitForSelector('.sheet #p-name');
  await sp.evaluate(url => window.__read(url), base + '#bag/011');
  await sp.waitForSelector('#toast:has-text("Close this to open #011")');
  assert.equal(await sp.evaluate(() => location.hash), '#part/p-12');
  assert.deepEqual(sp.problems, []);
  await sCtx.close();
}

// ---- a write that fails partway (the sticker taken away too soon) starts listening again by itself, up to five times, and
// says so in plain words (it stopped, and showed the browser's own message: "Couldn't write it (Failed to write due to an
// IO error)")
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: {}, parts: { 'p-12': { name: 'Thing 1', qty: 1, unit: 'pcs', tags: [], bag: 12, t: 1 } } } });
  const rCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  await rCtx.addInitScript(fakeNfc);
  await rCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const rp = await rCtx.newPage();
  rp.problems = []; rp.on('pageerror', e => rp.problems.push(e.message)); rp.on('console', m => { if (m.type() === 'error') rp.problems.push(m.text()); });
  const ioFail = () => rp.evaluate(() => window.__fail('NetworkError', 'Failed to write due to an IO error'));
  const listening = () => rp.waitForFunction(() => window.__waiting(), null, { timeout: 3000 });
  await rp.goto(base + '#part/p-12');
  await rp.click('#bagtag'); await rp.click('.sheet #write'); await listening();
  await ioFail(); await rp.waitForSelector('#tz.bad');
  assert.equal(await rp.textContent('#t-status'), 'Didn’t take. Hold it flat and still: still listening.');
  // listening again with no tap, and the next hold writes it
  await listening();
  assert.ok(await rp.evaluate(() => window.__tap())); await rp.waitForSelector('#tz.ok');
  assert.match((await rp.evaluate(() => window.__written)).at(-1), /#bag\/012$/);
  await rp.waitForFunction(() => !document.querySelector('.sheet'));
  // it stops after five tries of its own, and says to tap
  await rp.click('#bagtag'); await rp.click('.sheet #write'); await listening();
  for (let i = 0; i < 5; i++) { await ioFail(); await listening(); }
  await ioFail(); await rp.waitForTimeout(900);
  assert.equal(await rp.evaluate(() => window.__waiting()), false, 'it kept trying');
  assert.equal(await rp.textContent('#t-status'), 'Didn’t take. Hold it flat and still, then tap Write tag.');
  // a tap starts over, with five more tries
  await rp.click('.sheet #write'); await listening(); await ioFail(); await listening();
  // closed while it's about to try again: it doesn't
  await ioFail(); await rp.click('.sheet #done'); await rp.waitForTimeout(900);
  assert.equal(await rp.evaluate(() => window.__waiting()), false, 'it listened again with the sheet closed');
  assert.deepEqual(rp.problems, []);
  await rCtx.close();
}

// ---- Enter in a sheet's field saves, as in a form (it did nothing, and the sheet stayed open); a save refused puts the
// keyboard on the field concerned and marks it, until it's typed in
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: { 'b01': { code: 'B01', name: 'Sensors', t: 1 } }, parts: { 'p-q': { name: 'Counted part', binId: 'b01', qty: 3, unit: 'pcs', tags: [], t: 1 } } } });
  const eCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await eCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const ep = await eCtx.newPage();
  ep.problems = []; ep.on('pageerror', e => ep.problems.push(e.message)); ep.on('console', m => { if (m.type() === 'error') ep.problems.push(m.text()); });
  const gone = () => ep.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 3000 });
  await ep.goto(base + '#part/p-q'); await ep.click('#edit'); await ep.waitForSelector('.sheet #p-qty');
  await ep.fill('#p-qty', '7'); await ep.press('#p-qty', 'Enter'); await gone();
  assert.equal(await ep.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-q'].qty), 7);
  // Enter in a textarea is a new line, not a save
  await ep.click('#edit'); await ep.waitForSelector('.sheet #p-notes');
  await ep.fill('#p-notes', 'one'); await ep.press('#p-notes', 'Enter');
  assert.equal(await ep.locator('.sheet').count(), 1, 'Enter in Notes saved');
  // an empty name: the keyboard goes to it, marked, until it's typed in
  await ep.fill('#p-name', ''); await ep.click('.sheet #save');
  await ep.waitForSelector('#toast:has-text("Name is required")');
  assert.equal(await ep.evaluate(() => document.activeElement.id), 'p-name');
  assert.equal(await ep.getAttribute('#p-name', 'aria-invalid'), 'true');
  await ep.type('#p-name', 'C'); assert.equal(await ep.getAttribute('#p-name', 'aria-invalid'), null);
  await ep.press('.sheet #p-name', 'Escape'); await gone();
  // a new bin: Enter in Label code saves it
  await ep.goto(base + '#bins'); await ep.click('#addbin'); await ep.waitForSelector('.sheet #f-code');
  await ep.fill('#f-code', 'B01'); await ep.press('#f-code', 'Enter');
  await ep.waitForSelector('#toast:has-text("Code B01 already used")');
  assert.equal(await ep.evaluate(() => document.activeElement.id), 'f-code'); assert.equal(await ep.getAttribute('#f-code', 'aria-invalid'), 'true');
  await ep.fill('#f-code', 'B02'); await ep.press('#f-code', 'Enter'); await gone();
  assert.ok(await ep.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.bins).some(b => b.code === 'B02')));
  assert.deepEqual(ep.problems, []);
  await eCtx.close();
}

// ---- a sheet with no field puts the keyboard on its main button, inside the dialog (it was left on the page behind), and
// the tag sheet's messages are read out as they change
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: { 'b01': { code: 'B01', name: 'Sensors', t: 1 } }, parts: { 'p-12': { name: 'Thing 1', binId: 'b01', qty: 1, unit: 'pcs', tags: [], bag: 12, t: 1 } } } });
  const fCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await fCtx.addInitScript(fakeNfc);
  await fCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const fp = await fCtx.newPage();
  fp.problems = []; fp.on('pageerror', e => fp.problems.push(e.message)); fp.on('console', m => { if (m.type() === 'error') fp.problems.push(m.text()); });
  await fp.goto(base + '#part/p-12'); await fp.waitForSelector('#bagtag');
  await fp.focus('#bagtag'); await fp.keyboard.press('Enter'); await fp.waitForSelector('.sheet #write');
  assert.equal(await fp.evaluate(() => document.activeElement.id), 'write');
  assert.ok(await fp.evaluate(() => !!document.activeElement.closest('[role=dialog]')), 'the keyboard isn’t in the tag sheet');
  assert.equal(await fp.getAttribute('#t-status', 'role'), 'status');
  await fp.keyboard.press('Enter'); await fp.waitForSelector('#tz.wait');
  await fp.evaluate(() => window.__fail('NotAllowedError', 'The NFC tag already has data.'));
  await fp.waitForSelector('#tz.bad');
  assert.match(await fp.textContent('[role=dialog] [role=status]'), /^That sticker already holds a link\./);
  await fp.keyboard.press('Escape'); await fp.waitForFunction(() => !document.querySelector('.sheet'));
  // a bin's tag sheet, and the reference photo's, the same
  await fp.goto(base + '#bin/b01'); await fp.focus('#tag'); await fp.keyboard.press('Enter'); await fp.waitForSelector('.sheet #write');
  assert.equal(await fp.evaluate(() => document.activeElement.id), 'write');
  assert.deepEqual(fp.problems, []);
  await fCtx.close();
}

// ---- Edit on a part that's in a bag, in a browser that can't write tags: the bag shows as it is, with no tick box (an
// unticked "Keep it in bag #001" box suggested it would leave its bag, and ticking it did nothing)
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: {}, parts: { 'p-bagged': { name: 'Bagged part', qty: 2, unit: 'pcs', tags: [], bag: 1, t: 1 }, 'p-loose': { name: 'Loose part', qty: 1, unit: 'pcs', tags: [], t: 1 } } } });
  const kCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await kCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const kp = await kCtx.newPage();
  kp.problems = []; kp.on('pageerror', e => kp.problems.push(e.message)); kp.on('console', m => { if (m.type() === 'error') kp.problems.push(m.text()); });
  const got = id => kp.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  await kp.goto(base + '#part/p-bagged'); await kp.click('#edit'); await kp.waitForSelector('.sheet .bagtag');
  assert.equal(await kp.locator('#p-dotag').count(), 0, 'a tick box that does nothing here');
  assert.equal(await kp.textContent('.bagtag .bt-num'), '#001');
  assert.equal(await kp.textContent('.bagtag .bt-text'), 'In bag #001.Write the number on the bag.');
  assert.ok(await kp.$eval('.bagtag', e => e.classList.contains('on')), 'drawn as ticked');
  await kp.fill('#p-qty', '5'); await kp.click('.sheet #save'); await kp.waitForFunction(() => !document.querySelector('.sheet'));
  assert.equal((await got('p-bagged')).bag, 1); assert.equal((await got('p-bagged')).qty, 5);
  // emptying the bag number still takes it out of its bag
  await kp.click('#edit'); await kp.fill('#p-bag', '');
  assert.equal(await kp.textContent('.bagtag .bt-head'), 'Not in a bag'); assert.equal(await kp.textContent('#p-bagnote'), 'It leaves bag #001.');
  await kp.press('.sheet #p-name', 'Escape');
  // a part with no bag keeps its box: unticking leaves it without a number
  await kp.goto(base + '#part/p-loose'); await kp.click('#edit'); await kp.waitForSelector('.sheet #p-dotag');
  assert.ok(await kp.isChecked('#p-dotag'));
  assert.deepEqual(kp.problems, []);
  await kCtx.close();
}

// ---- a new screen says where you are: the keyboard goes to its heading and the page's title names it (it stayed "Parts
// Bin", and the keyboard dropped to the top of the page)
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: { 'b01': { code: 'B01', name: 'Sensors', t: 1 }, 'box-n': { code: 'BOX 03', kind: 'box', name: '', t: 1 } }, parts: { 'p-bme': { name: 'BME280 (Adafruit)', binId: 'b01', qty: 2, unit: 'pcs', tags: [], t: 1 } } } });
  const hCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await hCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const hp = await hCtx.newPage();
  hp.problems = []; hp.on('pageerror', e => hp.problems.push(e.message)); hp.on('console', m => { if (m.type() === 'error') hp.problems.push(m.text()); });
  await hp.goto(base + '#parts'); await hp.waitForSelector('.item');
  assert.equal(await hp.title(), 'Parts · Parts Bin');
  await hp.focus('.list .item'); await hp.keyboard.press('Enter'); await hp.waitForSelector('.binhead h2');
  assert.equal(await hp.evaluate(() => document.activeElement.tagName + ' ' + document.activeElement.textContent), 'H2 BME280 (Adafruit)');
  assert.equal(await hp.title(), 'BME280 (Adafruit) · Parts Bin');
  assert.equal(await hp.$eval('h2', e => getComputedStyle(e).outlineStyle), 'none', 'a ring round the heading');
  // Tab carries on from the heading, into the page (Edit, Bag tag, the count…), not the sidebar
  await hp.keyboard.press('Tab'); assert.ok(await hp.evaluate(() => document.getElementById('main').contains(document.activeElement)));
  // deleting the part ends on Parts, at its heading
  await hp.click('#edit'); hp.once('dialog', d => d.accept()); await hp.click('.sheet #del');
  await hp.waitForFunction(() => location.hash === '#parts'); await hp.waitForSelector('.topbar h2:has-text("Parts")');
  assert.equal(await hp.evaluate(() => document.activeElement.tagName + ' ' + document.activeElement.textContent), 'H2 Parts');
  // drawn again (a change in another tab) with the keyboard on the heading: it stays there
  await hp.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.bins.b01.notes = 'top shelf'; d.items.bins.b01.t = Date.now(); localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await hp.waitForTimeout(300);
  assert.equal(await hp.evaluate(() => document.activeElement.tagName + ' ' + document.activeElement.textContent), 'H2 Parts');
  // a box with no name is named by its code
  await hp.goto(base + '#bins'); await hp.focus('.bin:has-text("BOX 03")'); await hp.keyboard.press('Enter'); await hp.waitForSelector('.binhead');
  assert.equal(await hp.title(), 'BOX 03 · Parts Bin');
  // the sidebar keeps the keyboard on the screen picked
  await hp.focus('#nav [data-go="bom"]'); await hp.keyboard.press('Enter'); await hp.waitForSelector('#bom');
  assert.equal(await hp.evaluate(() => document.activeElement.dataset.go), 'bom'); assert.equal(await hp.title(), 'BOM check · Parts Bin');
  assert.deepEqual(hp.problems, []);
  await hCtx.close();
}

// ---- the Inbox from the keyboard: Skip and Apply say which part, each item is a heading, a struck-out old value is read
// as what it was, and after Skip or Apply the keyboard goes on to the next card (it dropped to the top of the page, and
// Skip said nothing)
{
  const INB = await import('file://' + join(root, 'js/inbox.js'));
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: {}, parts: {
    'p-bh': { name: 'BH1750 light sensor (GY-302)', category: 'Light', qty: 2, unit: 'pcs', tags: [], t: 1 },
    'p-ss': { name: 'SSD1306', qty: 1, unit: 'pcs', tags: [], t: 1 } } } });
  const iCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await iCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const ip = await iCtx.newPage();
  ip.problems = []; ip.on('pageerror', e => ip.problems.push(e.message)); ip.on('console', m => { if (m.type() === 'error') ip.problems.push(m.text()); });
  await ip.goto(base + '#' + await INB.encode({ partsbin: 1, batch: { id: 'ptest-keys', name: 'Bench', source: 'details', items: [
    { name: 'Rotary encoder', qty: 4 }, { id: 'p-bh', category: 'Sensors', addr: '0x23' }, { id: 'p-ss', iface: ['I2C'] }] } }));
  await ip.waitForSelector('.card.inb'); await ip.waitForSelector('#toast:has-text("3 from Claude to check")');
  const at = () => ip.evaluate(() => document.activeElement.closest('.card.inb')?.querySelector('.inb-head .t')?.textContent || document.activeElement.tagName + ' ' + document.activeElement.textContent);
  assert.equal(await ip.getByRole('heading', { level: 4, name: 'BH1750 light sensor (GY-302)' }).count(), 1, 'an item isn’t a heading');
  assert.equal(await ip.getByRole('button', { name: 'Skip BH1750 light sensor (GY-302)', exact: true }).count(), 1);
  assert.equal(await ip.getByRole('button', { name: 'Apply to BH1750 light sensor (GY-302)', exact: true }).count(), 1);
  assert.equal(await ip.getByRole('button', { name: 'Skip Rotary encoder', exact: true }).count(), 1);
  assert.equal(await ip.textContent('.card.inb[data-k="i1"] .diff input[data-k="category"] ~ .v'), 'was Light now Sensors');
  assert.equal(await ip.textContent('.card.inb[data-k="i1"] .diff input[data-k="category"] ~ .v s'), 'was Light');
  // Skip goes on to the next card, and says what it skipped
  await ip.getByRole('button', { name: 'Skip Rotary encoder' }).focus(); await ip.keyboard.press('Enter');
  await ip.waitForFunction(() => document.querySelectorAll('.card.inb').length === 2);
  assert.equal(await at(), 'BH1750 light sensor (GY-302)');
  // on screen too (only a screen reader was told), and said once
  await ip.waitForFunction(() => document.getElementById('say').textContent === 'Skipped Rotary encoder', null, { timeout: 2000 }).catch(() => assert.fail('Skip didn’t say what it skipped'));
  assert.ok(await ip.isVisible('#toast:has-text("Skipped Rotary encoder")'), 'Skip showed nothing');
  // Apply the same
  await ip.getByRole('button', { name: 'Apply to BH1750 light sensor (GY-302)' }).focus(); await ip.keyboard.press('Enter');
  await ip.waitForFunction(() => document.querySelectorAll('.card.inb').length === 1);
  assert.equal(await at(), 'SSD1306');
  // and after the last, the Inbox says it's empty
  await ip.getByRole('button', { name: 'Apply to SSD1306' }).focus(); await ip.keyboard.press('Enter');
  await ip.waitForSelector('text=Nothing waiting');
  assert.equal(await at(), 'H3 Nothing waiting');
  assert.deepEqual(ip.problems, []);
  await iCtx.close();
}

// ---- a browser with no NFC (an iPhone, a laptop) and one bin
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {}, bins: { 'b01': { code: 'B01', name: 'Sensors', location: 'Workroom', t: 1 } }, parts: { 'p-loose': { name: 'Loose part', qty: 1, unit: 'pcs', tags: [], t: 1 } } } });
  const nCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await nCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const np = await nCtx.newPage();
  np.problems = []; np.on('pageerror', e => np.problems.push(e.message)); np.on('console', m => { if (m.type() === 'error') np.problems.push(m.text()); });
  const got = id => np.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  // with only one bin, Pack starts on it (it started on "pick a box or bin", and the parts went in no bin)
  await np.goto(base + '#scan'); assert.equal(await np.inputValue('#dest'), 'b01');
  // saving in Pack says the bag's number to write on it, with no tag sheet that can't write a tag (it opened one for every bag)
  await np.fill('#desc', 'OLED 0.96'); await np.press('#desc', 'Enter'); await np.waitForSelector('.sheet #p-bag');
  assert.equal(await np.textContent('.bt-head'), 'Put it in bag #001'); assert.equal(await np.textContent('.sheet #save'), 'Save');
  await np.click('.sheet #save');
  await np.waitForSelector('#toast:has-text("Bag #001 saved. Write #001 on the bag.")');
  assert.equal(await np.locator('.sheet').count(), 0);
  assert.equal(await np.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(x => x.name === 'OLED 0.96').binId), 'b01');
  // where there's no clipboard at all, a tag's Copy link shows the link to copy by hand (it did nothing)
  await np.goto(base + '#part/p-loose'); await np.evaluate(() => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true }));
  await np.click('#bagtag'); await np.click('.sheet #copy');
  await np.waitForSelector('.sheet textarea');
  assert.equal(await np.inputValue('.sheet textarea'), base + '#bag/002'); assert.equal((await got('p-loose')).bag, 2);
  await np.click('.sheet #done');

  // a box is called a box: + Box opens "New box" (it said "New bin", then "Bin added"), and the title follows the Type
  await np.goto(base + '#scan'); await np.click('#newbox'); await np.waitForSelector('.sheet #f-kind');
  assert.equal(await np.evaluate(() => document.activeElement.id), 'f-code', 'on a laptop the first field has the keyboard');
  assert.equal(await np.textContent('.sheet h3'), 'New box');
  await np.selectOption('#f-kind', 'bin'); assert.equal(await np.textContent('.sheet h3'), 'New bin');
  await np.selectOption('#f-kind', 'box'); assert.equal(await np.textContent('.sheet h3'), 'New box');
  // the name comes second, after the label code, and Sealed is asked only of a moving box
  assert.deepEqual((await np.$$eval('.sheet .field label', l => l.map(x => x.textContent))).slice(0, 4), ['Label code', 'What\'s in it', 'Location', 'Type']);
  assert.ok(await np.isVisible('#f-sealed'));
  await np.selectOption('#f-kind', 'bin'); assert.ok(!(await np.isVisible('#f-sealed')), 'a permanent bin is asked if it is sealed');
  await np.selectOption('#f-kind', 'box'); assert.ok(await np.isVisible('#f-sealed'));
  await np.click('.sheet #save'); await np.waitForSelector('#toast:has-text("Box added")');
  await np.waitForFunction(() => location.hash.startsWith('#bin/') && !document.querySelector('.sheet'));
  await np.click('#edit'); assert.equal(await np.textContent('.sheet h3'), 'Edit box'); assert.equal(await np.textContent('.sheet #del'), 'Delete box');
  await np.click('.sheet #cancel');
  // a sealed box made a bin keeps what it said about being sealed (it shows nowhere while it's a bin)
  const newBox = await np.evaluate(() => location.hash.slice(5)), boxNow = () => np.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.bins[id], newBox);
  await np.click('#edit'); await np.selectOption('#f-sealed', '1'); await np.click('.sheet #save'); await np.waitForFunction(() => !document.querySelector('.sheet'));
  assert.equal((await boxNow()).sealed, true); assert.match(await np.textContent('.binhead .tiny'), /sealed/);
  await np.click('#edit'); await np.selectOption('#f-kind', 'bin'); await np.click('.sheet #save'); await np.waitForFunction(() => !document.querySelector('.sheet'));
  assert.deepEqual([(await boxNow()).kind, (await boxNow()).sealed], ['bin', true]); assert.doesNotMatch(await np.textContent('.binhead .tiny'), /sealed/);
  await np.click('#edit'); await np.selectOption('#f-kind', 'box'); assert.equal(await np.inputValue('#f-sealed'), '1');
  await np.selectOption('#f-sealed', ''); await np.click('.sheet #save'); await np.waitForFunction(() => !document.querySelector('.sheet')); // a box again, as below needs
  // a bin's printed list counts parts, and deleting it says what happens to them, in words (it said "part(s)")
  await np.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); const p = Object.values(d.items.parts).find(x => x.binId === 'b01' && !(x.del >= x.t)); p.notes = 'Two have a cracked corner · keep for testing'; p.t = Date.now(); localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); });
  await np.goto(base + '#bin/b01'); await np.evaluate(() => { window.print = () => {}; }); await np.click('#print');
  assert.match(await np.textContent('#print-root .sub'), / · 1 part · /);
  // a bin's list has no From (always empty there), and the notes print whole (they stopped at the first " · ")
  assert.deepEqual(await np.locator('#print-root thead th').allTextContents(), ['Done', 'Bag', 'Item', 'Qty', 'Notes']);
  assert.equal(await np.textContent('#print-root tbody td:last-child'), 'Two have a cracked corner · keep for testing');
  await np.click('#edit'); assert.equal(await np.textContent('.sheet h3'), 'Edit bin');
  const asked = new Promise(r => np.once('dialog', d => { r(d.message()); d.dismiss(); }));
  await np.click('.sheet #del'); assert.equal(await asked, 'Delete bin B01? Its part stays, without a bin.');
  await np.click('.sheet #cancel');
  // deleting a part names it, says what its bag's tag will do, and says it's done (it asked "Delete this part?", then
  // nothing)
  const oled = await np.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(([, x]) => x.name === 'OLED 0.96')[0]);
  await np.goto(base + '#part/' + oled); await np.click('#edit');
  const askedPart = new Promise(r => np.once('dialog', d => { r(d.message()); d.accept(); }));
  await np.click('.sheet #del'); assert.equal(await askedPart, 'Delete OLED 0.96? Bag #001’s tag will open nothing.');
  await np.waitForSelector('#toast:has-text("Deleted OLED 0.96")'); await np.waitForFunction(() => location.hash === '#parts');
  // and a box
  const box = await np.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.bins).find(([, x]) => x.kind === 'box')[0]);
  await np.goto(base + '#bin/' + box); await np.click('#edit');
  const askedBox = new Promise(r => np.once('dialog', d => { r(d.message()); d.accept(); }));
  await np.click('.sheet #del'); assert.equal(await askedBox, 'Delete box BOX 01?');
  await np.waitForSelector('#toast:has-text("Deleted box BOX 01")'); await np.waitForFunction(() => location.hash === '#bins');

  assert.deepEqual(np.problems, [], 'problems with no NFC');
  await nCtx.close();
}

// ---- search finds a name however it's half-remembered, and a bag number lists that bag's part first, then the rest
{
  const P = (name, bag) => ({ name, bag, binId: 'bin-s', category: 'Misc', qty: 1, unit: 'pcs', tags: [], t: 1 });
  const seed = { app: 'parts-bin', v: 1, items: { projects: {}, bins: { 'bin-s': { code: 'S1', name: 'Shelf', t: 1 } }, parts: {
    'p-xiao': P('Seeed XIAO ESP32-S3', 12), 'p-scd': P('SCD41 CO₂ sensor', 5), 'p-mhz': P('MH-Z19B CO2 sensor', 6), 'p-10k': P('10kΩ resistor', 220),
    'p-220': P('220Ω resistors', 3), 'p-220u': P('220uF capacitor', 40), 'p-pot': P('10 kΩ potentiometer', 41), 'p-other': P('BME280', 22) } } };
  const sCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await sCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, JSON.stringify(seed));
  const sp = await sCtx.newPage();
  sp.problems = []; sp.on('pageerror', e => sp.problems.push(e.message));
  await sp.goto(base + '#parts'); await sp.waitForSelector('.list .item');
  const found = async q => { await sp.fill('#q', q); await sp.waitForTimeout(400); return sp.locator('#main .list .item .t').allTextContents(); }; // after search's pause
  // typed without the dash (ESP32-S3 is "esp32 s3" to search), and CO₂ with a plain 2 (the ₂ was a space)
  assert.deepEqual(await found('esp32s3'), ['Seeed XIAO ESP32-S3']);
  assert.equal(await sp.textContent('#say'), '1 part', 'what search found is said');
  assert.deepEqual((await found('co2')).sort(), ['MH-Z19B CO2 sensor', 'SCD41 CO₂ sensor']);
  assert.deepEqual((await found('10k')).sort(), ['10 kΩ potentiometer', '10kΩ resistor']);
  // bag 220's part comes first, and the parts with 220 in their names after it (only bag 220's showed)
  assert.deepEqual(await found('220'), ['10kΩ resistor', '220uF capacitor', '220Ω resistors']);
  assert.deepEqual(await found('#220'), ['10kΩ resistor', '220uF capacitor', '220Ω resistors']);
  // and another bag's number in it isn't a match: bag 22 is the BME280, which has no 22 in its name
  assert.deepEqual(await found('22'), ['BME280', '220uF capacitor', '220Ω resistors']);
  assert.equal(await sp.textContent('#say'), '3 parts');
  // on Bins, the bins it found too
  await sp.goto(base + '#bins'); await sp.fill('#q', 'shelf'); await sp.waitForFunction(() => document.getElementById('say').textContent === '8 parts, 1 bin');
  await sp.fill('#q', 'esp32s3'); await sp.waitForFunction(() => document.getElementById('say').textContent === '1 part, 0 bins');
  assert.deepEqual(sp.problems, [], 'problems while searching');
  await sCtx.close();
}

// ---- a number in a name isn't a bag number: in Pack, Enter on "Pin header 40 pin" opened the 6-pin header in bag #040
// and saved the count typed over its own, and Parts listed NEMA 23 (bag #117) for "nema 17"
{
  const P = (name, bag, qty) => ({ name, bag, qty, binId: 'bin-c', category: 'Connectors', unit: 'pcs', tags: [], t: 1 });
  const seed = { app: 'parts-bin', v: 1, items: { projects: {}, bins: { 'bin-c': { code: 'C1', name: 'Connectors', t: 1 } }, parts: {
    'p-ph6': P('Pin header 6 pin', 40, 12), 'p-nema': P('NEMA 23 stepper motor', 117, 2), 'p-10k': P('Resistor 10k', 220, 100),
    'p-jst': P('JST-XH 12 pin', 9, 4), 'p-led': P('LED 3mm red', 15, 30), 'p-555': P('555 timer', 3, 10) } } };
  const kCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await kCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, JSON.stringify(seed));
  const kp = await kCtx.newPage();
  kp.problems = []; kp.on('pageerror', e => kp.problems.push(e.message));
  const got = id => kp.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
  const enter = async (q, h3) => {
    await kp.goto(base + '#scan'); await kp.waitForSelector('#desc'); await kp.fill('#desc', q); await kp.press('#desc', 'Enter');
    await kp.waitForSelector('.sheet #p-name', { timeout: 2000 });
    assert.equal(await kp.textContent('.sheet h3'), h3, q); return kp.inputValue('#p-name');
  };
  assert.equal(await enter('Pin header 40 pin', 'New part'), 'Pin header 40 pin');
  await kp.click('.sheet #save'); await kp.waitForFunction(() => !document.querySelector('.sheet'));
  const ph6 = await got('p-ph6');
  assert.deepEqual([ph6.qty, ph6.binId, ph6.bag], [12, 'bin-c', 40], 'the 6-pin header kept its count, bin and bag');
  assert.ok(await kp.evaluate(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.parts).some(x => x.name === 'Pin header 40 pin')), 'the 40-pin header was made');
  // the list still offers the part with that bag number, for a tap
  await kp.goto(base + '#scan'); await kp.fill('#desc', 'Pin header 40 pin'); await kp.waitForSelector('.matchlist [data-id="p-ph6"]');
  for (const q of ['NEMA 17 stepper motor', 'Resistor 220', 'LED 1', 'JST-XH 2 pin']) { await enter(q, 'New part'); await kp.click('.sheet #cancel'); await kp.waitForFunction(() => !document.querySelector('.sheet')); }
  // a part named by every word still opens on Enter
  assert.equal(await enter('NEMA 23', 'Edit part'), 'NEMA 23 stepper motor'); await kp.click('.sheet #cancel');
  assert.equal(await enter('jst xh 12', 'Edit part'), 'JST-XH 12 pin'); await kp.click('.sheet #cancel');
  assert.equal(await enter('#117', 'Edit part'), 'NEMA 23 stepper motor', 'a bag number on its own opens its part'); await kp.click('.sheet #cancel');
  assert.equal(await enter('bag 117', 'Edit part'), 'NEMA 23 stepper motor', 'and with the word bag'); await kp.click('.sheet #cancel');
  assert.equal(await enter('555', 'Edit part'), '555 timer', 'and a number that’s the whole name, its part'); await kp.click('.sheet #cancel');
  // Parts: a number in the search is a bag only as the whole number, and a bag number on its own still lists that bag first
  await kp.goto(base + '#parts'); await kp.waitForSelector('.list .item');
  const found = async q => { await kp.fill('#q', q); await kp.waitForTimeout(400); return kp.locator('#main .list .item .t').allTextContents(); };
  assert.deepEqual(await found('nema 17'), []);
  assert.deepEqual(await found('nema 117'), ['NEMA 23 stepper motor'], 'its own bag number with a word finds it');
  assert.equal((await found('117'))[0], 'NEMA 23 stepper motor'); assert.equal((await found('#117'))[0], 'NEMA 23 stepper motor');
  // "bag 117" is the bag number too (the word bag left the details searched, so it found nothing)
  for (const q of ['bag 117', 'Bag #117', 'bag117']) assert.equal((await found(q))[0], 'NEMA 23 stepper motor', q);
  assert.deepEqual(await found('resistor 22'), []);
  assert.deepEqual(kp.problems, [], 'problems in Pack and search');
  await kCtx.close();
}

// ---- a long inventory on a phone
{
  const seed = { app: 'parts-bin', v: 1, items: { projects: {}, bins: { 'bin-a': { code: 'A1', name: 'Resistor drawer', location: 'Workroom', t: 1 } }, parts: {} } };
  for (let i = 1; i <= 300; i++) seed.items.parts['p' + i] = { name: 'Resistor ' + String(i).padStart(3, '0') + ' ohm', binId: 'bin-a', category: 'Passives', qty: i, unit: 'pcs', tags: [], t: 1 };
  const lCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await lCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, JSON.stringify(seed));
  const lp = await lCtx.newPage();
  lp.problems = []; lp.on('pageerror', e => lp.problems.push(e.message)); lp.on('console', m => { if (m.type() === 'error') lp.problems.push(m.text()); });
  await lp.goto(base + '#parts'); await lp.waitForSelector('.list .item');
  // Back from a part lands where the list was (it went to the top, with up to 1,500 rows to scroll past again), from
  // the page's Back and the phone's; a part opened from it starts at the top
  const openRow = () => lp.evaluate(() => { const r = [...document.querySelectorAll('.list .item')].find(e => e.getBoundingClientRect().top > 200); const n = r.querySelector('.t').textContent; r.click(); return n; });
  for (const back of [() => lp.click('#back'), () => lp.goBack()]) {
    await lp.evaluate(() => scrollTo(0, 9000)); const y0 = await lp.evaluate(() => scrollY); assert.ok(y0 > 8000);
    const name = await openRow();
    await lp.waitForSelector(`#main h2:has-text("${name}")`);
    assert.equal(await lp.evaluate(() => scrollY), 0, 'a part opens at the top');
    await back(); await lp.waitForFunction(() => location.hash === '#parts');
    const y1 = await lp.evaluate(() => scrollY);
    assert.ok(Math.abs(y1 - y0) < 64, `Back to Parts landed at ${y1}, not where the list was (${y0})`);
  }
  // a tab opens its screen at the top, though
  await lp.click('#tabbar [data-go="bins"]'); await lp.waitForSelector('.bin');
  await lp.click('#tabbar [data-go="parts"]'); await lp.waitForSelector('.list .item');
  assert.equal(await lp.evaluate(() => scrollY), 0, 'Parts from the tab bar opens at the top');
  // a save or a sync draws the screen once (it drew it twice, once for the bins and once for the parts: about a second
  // for a long list on a slow phone)
  const draws = async change => {
    await lp.evaluate(() => { window.__draws = 0; window.__mo?.disconnect(); window.__mo = new MutationObserver(rs => { for (const r of rs) if (r.removedNodes.length) window.__draws++; }); window.__mo.observe(document.getElementById('main'), { childList: true }); });
    await change(); await lp.waitForTimeout(300);
    return lp.evaluate(() => { window.__mo.disconnect(); return window.__draws; });
  };
  assert.equal(await draws(() => lp.evaluate(() => { const d = JSON.parse(localStorage.getItem('parts-bin')); d.items.parts.p7.qty = 70; d.items.parts.p7.t = Date.now(); localStorage.setItem('parts-bin', JSON.stringify(d)); dispatchEvent(new StorageEvent('storage', { key: 'parts-bin' })); })), 1, 'a sync drew Parts more than once');
  await lp.waitForSelector('.list .item:has-text("Resistor 007") .q:has-text("70")');
  await lp.goto(base + '#part/p7'); await lp.waitForSelector('#inc');
  assert.equal(await draws(() => lp.click('#inc')), 1, 'a save drew the part page more than once');
  assert.equal(await lp.inputValue('#qv'), '71');
  // the new count is said, as the keyboard stays on the button and nothing else moves
  await lp.waitForFunction(() => document.getElementById('say').textContent === '71 pcs', null, { timeout: 2000 }).catch(() => assert.fail('Add one said nothing'));
  await lp.focus('#dec'); await lp.keyboard.press('Enter');
  await lp.waitForFunction(() => document.getElementById('say').textContent === '70 pcs', null, { timeout: 2000 }).catch(() => assert.fail('Use one said nothing'));
  // on a phone, a sheet opens without the keyboard (it popped up over half the sheet) and Save is in reach at the bottom
  // of the screen without scrolling the long part sheet
  await lp.click('#edit'); await lp.waitForSelector('.sheet #p-name');
  await lp.waitForFunction(() => !document.querySelector('.sheet').getAnimations().length); // risen into place
  assert.ok(await lp.evaluate(() => document.activeElement.classList.contains('sheet')), 'a field took the keyboard as the sheet opened');
  const inView = sel => lp.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, sel);
  assert.ok(await lp.evaluate(() => { const s = document.querySelector('.sheet'); return s.scrollHeight > s.clientHeight + 200; }), 'the part sheet is long enough to scroll');
  assert.ok(await inView('.sheet #save'), 'Save is below the bottom of the screen');
  await lp.evaluate(() => { const s = document.querySelector('.sheet'); s.scrollTop = s.scrollHeight / 2; });
  assert.ok(await inView('.sheet #save'), 'Save scrolled away with the sheet');
  await lp.click('.sheet #cancel');
  await lp.waitForFunction(() => !document.querySelector('.sheet'));
  // typing in search keeps the search box, with the keyboard and the caret where they were (the box was drawn again
  // after each pause, with the caret moved to the end)
  await lp.goto(base + '#parts'); await lp.waitForSelector('.list .item');
  await lp.evaluate(() => { window.__q0 = document.getElementById('q'); });
  await lp.click('#q'); await lp.keyboard.type('resistor 02', { delay: 30 });
  await lp.waitForFunction(() => document.querySelectorAll('.list .item').length < 50); await lp.waitForTimeout(300);
  assert.ok(await lp.evaluate(() => window.__q0 === document.getElementById('q') && document.activeElement === window.__q0), 'the search box was made again');
  await lp.evaluate(() => window.__q0.setSelectionRange(8, 8)); // after "resistor", to put a word in the middle
  await lp.keyboard.type(' 1', { delay: 30 }); await lp.waitForTimeout(400);
  assert.equal(await lp.inputValue('#q'), 'resistor 1 02');
  assert.deepEqual(await lp.evaluate(() => [window.__q0 === document.getElementById('q'), window.__q0.selectionStart]), [true, 10], 'the caret moved while typing in the middle');
  assert.deepEqual(lp.problems, [], 'problems with a long inventory');
  await lCtx.close();
}

// ---- two boxes with one code (each device made BOX 01 before they synced): either can still be edited (Save said "Code
// BOX 01 already used" until one was renamed, and nothing said so), the Bins page and each box's page say to rename one,
// and Pack's list tells them apart
{
  const seed = JSON.stringify({ app: 'parts-bin', v: 1, items: { projects: {},
    bins: { 'box-a': { code: 'BOX 01', kind: 'box', name: '', location: 'Moving boxes', t: 1 }, 'box-b': { code: 'BOX 01', kind: 'box', name: '', location: 'Moving boxes', tagWritten: true, t: 2 },
      'bin-c': { code: 'C1', name: 'Cables', location: 'Workroom', t: 1 } },
    parts: { 'p-1': { name: 'Buzzer', binId: 'box-b', qty: 1, unit: 'pcs', tags: [], bag: 1, t: 1 } } } });
  const tCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await tCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, seed);
  const tp = await tCtx.newPage();
  tp.problems = []; tp.on('pageerror', e => tp.problems.push(e.message)); tp.on('console', m => { if (m.type() === 'error') tp.problems.push(m.text()); });
  await tp.goto(base + '#bins'); await tp.waitForSelector('.codenote');
  assert.equal(await tp.locator('.codenote').count(), 1);
  assert.match(await tp.textContent('.codenote'), /BOX 01 is on two boxes\. Rename one, and rewrite its label\./);
  assert.match(await tp.textContent('#sidefoot'), /^3 bins · 1 part\b/, 'one part is "1 part"');
  // Pack's list: no trailing " · " on a box with no name, and the two told apart by how full each is, which every box and
  // bin there says
  await tp.goto(base + '#scan'); await tp.waitForSelector('#dest');
  assert.deepEqual(await tp.$$eval('#dest option', os => os.slice(1).map(o => o.textContent)), ['BOX 01 · 0 bags', 'BOX 01 · 1 bag', 'C1 · Cables · 0 parts']);
  // the box without a tag written is changed and saved, with its code as it was
  await tp.goto(base + '#bin/box-a'); await tp.waitForSelector('.codenote');
  await tp.click('#edit'); await tp.waitForSelector('.sheet #f-name');
  await tp.fill('.sheet #f-name', 'Kitchen stuff'); await tp.click('.sheet #save');
  await tp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.bins['box-a'].name === 'Kitchen stuff');
  assert.equal(await tp.locator('.sheet').count(), 0, 'the sheet stayed open');
  assert.match(await tp.textContent('#toast'), /^Saved/);
  // a code typed that another bin has is still refused
  await tp.click('#edit'); await tp.waitForSelector('.sheet #f-code');
  await tp.fill('.sheet #f-code', 'c1'); await tp.click('.sheet #save');
  await tp.waitForSelector('#toast:has-text("Code c1 already used")'); assert.equal(await tp.locator('.sheet').count(), 1);
  await tp.click('.sheet #cancel');
  // Rename on the box's page goes straight to the code; a new one there clears the note everywhere
  await tp.waitForSelector('.codenote'); await tp.click('.codenote .btn'); await tp.waitForSelector('.sheet #f-code');
  assert.equal(await tp.evaluate(() => document.activeElement.id), 'f-code');
  await tp.fill('.sheet #f-code', 'BOX 02'); await tp.click('.sheet #save');
  await tp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.bins['box-a'].code === 'BOX 02');
  await tp.waitForFunction(() => !document.querySelector('.codenote'));
  await tp.goto(base + '#bins'); await tp.waitForSelector('.bin'); assert.equal(await tp.locator('.codenote').count(), 0);
  await tp.goto(base + '#scan'); await tp.waitForSelector('#dest');
  assert.deepEqual(await tp.$$eval('#dest option', os => os.slice(1).map(o => o.textContent)), ['BOX 01 · 1 bag', 'BOX 02 · Kitchen stuff · 0 bags', 'C1 · Cables · 0 parts']);
  assert.deepEqual(tp.problems, [], 'problems with two boxes on one code');
  await tCtx.close();
}

// ---- Drive on and no signal: opened from the offline copy, with Google's sign-in script not loading, the cloud button
// and Settings said Google had signed you out ("Tap to sign in to Google again", "Google Drive: not synced") though the
// sign-in was minutes old. They say it's offline, and a change made meanwhile reaches Drive once the signal's back.
{
  let down = false, cut = false;
  const dServer = createServer((req, res) => { if (down) { req.socket.destroy(); return; } serve(req, res, dOrigin); });
  await new Promise(r => dServer.listen(0, r));
  const dOrigin = `http://localhost:${dServer.address().port}`, dBase = dOrigin + '/';
  const dCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await g.install(dCtx);
  await dCtx.route(/^https:\/\/(accounts\.google\.com|www\.googleapis\.com)\//, r => (cut ? r.abort('internetdisconnected') : r.fallback()));
  const dp = await dCtx.newPage();
  dp.problems = []; dp.on('pageerror', e => dp.problems.push(e.message));
  await dp.goto(dBase);
  await dp.evaluate(() => { localStorage.setItem('__who', 'offbench'); localStorage.setItem('parts-bin', JSON.stringify({ app: 'parts-bin', v: 1, items: { bins: {}, projects: {}, parts: { 'p-n': { name: 'Nano', qty: 5, unit: 'pcs', t: 1 } } } })); });
  await dp.goto(dBase + '#settings'); await dp.reload();
  await dp.click('[data-a="on"]');
  await dp.waitForFunction(() => /Last synced/.test(document.querySelector('#drivecard')?.textContent || ''), null, { timeout: 10000 });
  await dp.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
  const theFile = () => g.files().find(f => f.owner === 'offbench' && f.appProperties?.partsbin === 'sync' && !f.trashed);
  assert.equal(JSON.parse(theFile().body).items.parts['p-n'].qty, 5);
  const chip = () => dp.evaluate(() => { const b = document.querySelector('#cloud-m'); return b.dataset.s + ' | ' + b.title; });
  // no signal, and opened again
  down = cut = true; await dCtx.setOffline(true);
  const gisFailed = dp.waitForEvent('requestfailed', r => r.url().startsWith('https://accounts.google.com/gsi/client'), { timeout: 10000 });
  await dp.goto(dBase + '#bins'); await dp.reload(); await gisFailed; await dp.waitForTimeout(300);
  assert.match(await chip(), /^offline \| Offline\. Changes are kept on this device/, 'opened with no signal');
  await dp.goto(dBase + '#part/p-n'); await dp.waitForSelector('#inc'); await dp.click('#inc');
  await dp.waitForFunction(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-n'].qty === 6); await dp.waitForTimeout(1800);
  assert.match(await chip(), /^offline \| /, 'after a change with no signal');
  await dp.goto(dBase + '#settings'); await dp.waitForSelector('#drivecard [data-a="now"]'); await dp.waitForTimeout(500);
  const card = (await dp.textContent('#drivecard')).replace(/\s+/g, ' ');
  assert.match(card, /^ ?Saved to Google Drive .*Offline\. Changes are kept on this device and go to Drive when you’re back online\./);
  assert.doesNotMatch(card, /not synced|sign in|signs you out/i); assert.doesNotMatch(await chip(), /sign in/i);
  // the signal's back: the change goes to Drive by itself
  down = cut = false; await dCtx.setOffline(false);
  await until(() => JSON.parse(theFile().body).items.parts['p-n'].qty === 6, 'the change made with no signal to reach Drive');
  await dp.waitForFunction(() => document.querySelector('#cloud-m').dataset.s === 'ok', null, { timeout: 10000 });
  assert.deepEqual(dp.problems, [], 'problems with Drive on and no signal');
  await dCtx.close(); dServer.close();
}

// ---- carry.js: the first time Parts Bin opens at parts-bin.junkdrawer.works it brings the inventory over from its old
// address, junkdrawer.works/parts-bin/, by asking junkdrawer.works/carry.html in a hidden frame (on localhost it does
// nothing, so here the page is served at its real address). It mustn't keep the page from opening when carry.html never
// answers, and it never writes over what this address already has.
{
  const APP = 'https://parts-bin.junkdrawer.works/', t0 = 1760000000000;
  const oldDoc = { app: 'parts-bin', v: 1, items: { bins: { 'b-old': { code: 'OLD', name: 'From the old address', t: t0 } }, parts: { 'p-old': { name: 'Carried part', binId: 'b-old', qty: 2, bag: 7, t: t0 } }, projects: {} } };
  const ownDoc = { app: 'parts-bin', v: 1, items: { bins: { 'b-own': { code: 'OWN', name: 'Made here', t: t0 } }, parts: { 'p-own': { name: 'Own part', binId: 'b-own', qty: 1, t: t0 } }, projects: {} } };
  const carry = async ({ answer, preset, carried }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx.route(APP + '**', async r => { const p = new URL(r.request().url()).pathname;
      try { await r.fulfill({ body: await readFile(join(root, p === '/' ? 'index.html' : p)), contentType: TYPES[extname(p)] || 'text/html' }); } catch { await r.fulfill({ status: 404, body: '' }); } });
    // the old address's saves, as carry.html hands them over; or a carry.html that loads and never answers
    await ctx.route('https://junkdrawer.works/carry.html', r => r.fulfill({ contentType: 'text/html', body: `<script>addEventListener('message', e => { ${answer === 'empty' ? 'e.source.postMessage({ carried: { local: {}, idb: [] } }, e.origin);' : answer ? `e.source.postMessage({ carried: { local: { 'parts-bin': ${JSON.stringify(JSON.stringify(oldDoc))}, 'sr.cat': '""' }, idb: [] } }, e.origin);` : ''} });</script>` }));
    await ctx.route('https://accounts.google.com/**', r => r.abort());
    const pg = await ctx.newPage(); pg.problems = [];
    pg.on('pageerror', e => pg.problems.push(e.message));
    if (preset || carried) { await pg.goto(APP + 'manifest.webmanifest'); await pg.evaluate(([d, c]) => { if (d) localStorage.setItem('parts-bin', d); if (c) localStorage.setItem('junkdrawer.carried', c); }, [preset && JSON.stringify(preset), carried]); }
    const at = Date.now();
    await pg.goto(APP + '#bins');
    return { ctx, pg, at, saved: () => pg.evaluate(() => ({ cat: localStorage.getItem('sr.cat'), done: localStorage.getItem('junkdrawer.carried'), tries: localStorage.getItem('junkdrawer.carry-tries'), doc: JSON.parse(localStorage.getItem('parts-bin') || 'null') })) };
  };
  // a first visit: the old address's inventory comes over, and the page opens with it
  let c = await carry({ answer: true });
  await c.pg.waitForSelector('.bin:has-text("From the old address")', { timeout: 10000 });
  let st = await c.saved(); assert.ok(st.done, 'carried, and noted'); assert.equal(st.doc.items.parts['p-old'].name, 'Carried part');
  assert.deepEqual(c.pg.problems, []); await c.ctx.close();
  // carry.html never answering: the page still opens after the short wait (3 s once it has loaded), and tries again next visit
  c = await carry({ answer: false });
  await c.pg.waitForSelector('text=No bins yet', { timeout: 10000 });
  assert.ok(Date.now() - c.at < 8000, `the page took ${Date.now() - c.at} ms to open with carry.html not answering`);
  st = await c.saved(); assert.equal(st.done, null); assert.equal(st.tries, '1');
  assert.deepEqual(c.pg.problems, []); await c.ctx.close();
  // an address that already has its own inventory: nothing in it is written over
  c = await carry({ answer: true, preset: ownDoc });
  await c.pg.waitForSelector('.bin:has-text("Made here")', { timeout: 10000 });
  st = await c.saved(); assert.ok(st.done); assert.deepEqual(st.doc, ownDoc, 'the inventory made here was written over');
  assert.equal(st.cat, '""', 'what this address didn’t have came over'); // so carry.js did run
  assert.equal(await c.pg.locator('.bin:has-text("From the old address")').count(), 0);
  assert.deepEqual(c.pg.problems, []); await c.ctx.close();
  // carried long ago (or given up on after three tries), with something already saved here: Settings brings over what the
  // old address has, adding what isn't here and writing over nothing (the old inventory was out of reach for good)
  const ownNewer = { ...ownDoc, items: { ...ownDoc.items, parts: { ...ownDoc.items.parts, 'p-old': { name: 'Renamed here', binId: 'b-own', qty: 9, t: t0 - 5 } } } };
  c = await carry({ answer: true, preset: ownNewer, carried: 'gave up' });
  await c.pg.waitForSelector('.bin:has-text("Made here")', { timeout: 10000 });
  await c.pg.goto(APP + '#settings');
  assert.ok(await c.pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the long button pushes the page sideways');
  await c.pg.click('#old');
  await c.pg.waitForSelector('#toast:has-text("Brought over 1 bin from junkdrawer.works/parts-bin.")');
  st = await c.saved();
  assert.equal(st.doc.items.bins['b-old'].name, 'From the old address');
  assert.deepEqual(st.doc.items.parts['p-old'], ownNewer.items.parts['p-old'], 'a part that’s here is left as it is, though the old copy is newer');
  assert.deepEqual(st.doc.items.bins['b-own'], ownDoc.items.bins['b-own']);
  await c.pg.click('#old'); await c.pg.waitForSelector('#toast:has-text("Everything saved at junkdrawer.works/parts-bin is here already.")');
  assert.deepEqual(c.pg.problems, []); await c.ctx.close();
  // nothing saved there, or junkdrawer.works not answering: it says so; and the empty Bins screen points to it
  c = await carry({ answer: 'empty', carried: 'gave up' });
  await c.pg.waitForSelector('text=No bins yet');
  assert.match(await c.pg.textContent('#main .empty'), /Used Parts Bin at junkdrawer\.works\/parts-bin before\? Bring that inventory over in Settings\./);
  await c.pg.click('#main .empty a[href="#settings"]'); await c.pg.click('#old');
  await c.pg.waitForSelector('#toast:has-text("There’s nothing saved at junkdrawer.works/parts-bin in this browser.")');
  assert.deepEqual(c.pg.problems, []); await c.ctx.close();
  c = await carry({ answer: false, carried: 'gave up' });
  await c.pg.goto(APP + '#settings'); await c.pg.click('#old');
  await c.pg.waitForSelector('#toast:has-text("Couldn’t reach junkdrawer.works. Check the connection and try again.")', { timeout: 15000 });
  assert.equal(await c.pg.isEnabled('#old'), true);
  assert.deepEqual(c.pg.problems, []); await c.ctx.close();
}

// ---- works offline once it has been opened: every screen, the inventory and the fonts, with no network at all. The
// server goes down as well as the browser: in some Chromium builds the browser's offline switch alone doesn't stop the
// service worker's own requests, and this passed with no copy at all.
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const SHELL = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const offCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const off = await offCtx.newPage();
off.problems = [];
off.on('pageerror', e => off.problems.push(e.message));
off.on('console', m => { if (m.type() === 'error') off.problems.push(m.text()); });
await off.goto(base);
await off.evaluate(v => localStorage.setItem('parts-bin', v), await page.evaluate(() => localStorage.getItem('parts-bin')));
await off.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
// it installs: Chromium finds nothing missing (a manifest, its icons, the offline copy)
const cdp = await offCtx.newCDPSession(off);
assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'Chromium says it can’t be installed');
net = 'down';
await offCtx.setOffline(true);
const screens = [['#bins', 'Bins'], ['#bin/bin-env', 'Environmental'], ['#bin/box-move', 'Bench'], ['#parts', 'Parts'], ['#part/p-bme280', 'BME280'],
  ['#bag/001', 'BME280'], ['#bom', 'BOM check'], ['#scan', 'Pack'], ['#inbox', 'Inbox'], ['#settings', 'Settings']];
for (const [hash, title] of screens) {
  await off.goto(base + hash); // the same page with another #, so it's the reload that opens it from the copy
  await off.reload();
  await off.waitForSelector(`#main h2:has-text("${title}")`, { timeout: 5000 }).catch(() => assert.fail(`${hash} didn’t open offline`));
}
// a link from Claude opened with no signal (a chat read on the train) opens its batch in the Inbox
const offLink = base + '#' + await IN.encode({ partsbin: 1, batch: { id: 'ptest-offline', name: 'Read on the train', source: 'photo', items: [{ name: 'MAX98357 I2S amp', qty: 2 }] } });
await off.goto('about:blank'); await off.goto(offLink);
await off.waitForSelector('.batch:has-text("Read on the train") .card.inb', { timeout: 5000 }).catch(() => assert.fail('a link from Claude didn’t open offline'));
assert.equal(await off.evaluate(() => location.hash), '#inbox');
await off.goto(base + '#bins'); await off.reload(); await off.waitForSelector('.bin:has-text("Environmental")');
await off.evaluate(() => document.fonts.ready);
assert.ok(await off.evaluate(() => document.fonts.check('600 24px "Barlow Condensed"') && document.fonts.check('16px Barlow')), 'the fonts came from the offline copy');
await offCtx.setOffline(false);
// On a connection that's up but not answering (a garage with one bar, a captive wifi), it opens from the copy too,
// after the worker's few seconds' wait for the network: the page and every file it loads (were any of them left waiting
// on the network, it wouldn't open).
net = 'stalled';
const t0 = Date.now();
await off.reload({ timeout: 10000 }).catch(() => {});
const took = Date.now() - t0;
assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
await off.waitForSelector('.bin:has-text("Environmental")', { timeout: 1000 }).catch(() => assert.fail('the inventory didn’t show on a stalled connection'));
net = 'up';
for (const [req, res] of held.splice(0)) serve(req, res);
// A new release: every file in the new copy comes from the server, though the browser still has its own copies of the
// old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
release = true;
await off.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await until(() => off.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
  'the new release’s offline copy to have the new index.html (it kept the old one)');
release = false;
// everything any device asked this server for is in the offline copy
assert.deepEqual([...asked].map(p => (p === '/' ? './' : p.slice(1))).filter(p => p !== 'sw.js' && !SHELL.includes(p)), [], 'files the page loads that the offline copy doesn’t keep');
for (const p of [page, laptop.page, other.page, off]) assert.deepEqual(p.problems, [], 'problems while using it');
await browser.close();
server.close();

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
const all = createHash('sha1');
for (const f of SHELL) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
console.log('all good');
