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
await page.selectOption('#dest', 'bin-env');
await page.fill('#desc', 'bme');
await page.waitForSelector('.matchlist [data-id="p-bme280"]');
await page.click('.matchlist [data-id="p-bme280"]');
await page.waitForSelector('#p-name');
assert.equal(await page.inputValue('#p-bag'), '1');
await page.fill('#p-qty', '4');
await page.click('.sheet #save');
await page.waitForSelector('#tz.wait'); // listening for the sticker without another tap
assert.ok(await page.evaluate(() => window.__tap()));
await page.waitForSelector('#tz.ok');
assert.match((await page.evaluate(() => window.__written))[0], /#bag\/001$/);
await page.waitForFunction(() => !document.querySelector('.sheet'));
const bme = await page.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-bme280']);
assert.equal(bme.qty, 4); assert.equal(bme.bag, 1); assert.equal(bme.tagWritten, true);
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
await page.click('text=Bag tag');
assert.match(await page.textContent('.sheet h3'), /#004/);
assert.match(await page.textContent('.sheet'), /This will be bag #004/);
// looking at the sheet and backing out takes no number
assert.equal(await page.textContent('.sheet #done'), 'Cancel');
await page.click('.sheet #done');
assert.ok(!(await spare()).bag);
await page.click('text=Bag tag');
await page.click('.sheet #write');
await page.waitForSelector('#tz.wait');
await page.evaluate(() => window.__tap());
await page.waitForFunction(() => !document.querySelector('.sheet'));
assert.equal((await page.evaluate(() => window.__written)).at(-1), base + '#bag/004');
assert.equal((await spare()).bag, 4); assert.equal((await spare()).tagWritten, true);
assert.equal(await page.textContent('.binhead .bagno'), '#004');
// if the number is taken while the sheet is open (another tab, a sync), it stops rather than double up
await page.goto(base + '#parts'); await page.click('#addp'); await page.fill('#p-name', 'Second spare'); await page.uncheck('#p-dotag'); await page.click('.sheet #save');
await page.waitForFunction(() => !document.querySelector('.sheet'));
const second = await page.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.parts).find(([, x]) => x.name === 'Second spare')[0]);
await page.goto(base + '#part/' + second); await page.click('text=Bag tag');
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
// tagging it again keeps its number
await page.click('text=Bag tag');
await page.click('.sheet #write');
await page.waitForSelector('#tz.wait');
await page.evaluate(() => window.__tap());
await page.waitForFunction(() => !document.querySelector('.sheet'));
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
// a list typed but not checked yet stays through another screen, a reload, and Save as project
await page.fill('#bom', '1 SCD41\n2 heat-set inserts');
await page.click('#tabbar [data-go="parts"]'); await page.waitForSelector('#cat');
await page.click('#tabbar [data-go="bom"]'); await page.waitForSelector('#bom');
assert.equal(await page.inputValue('#bom'), '1 SCD41\n2 heat-set inserts');
await page.reload(); await page.waitForSelector('#bom');
assert.equal(await page.inputValue('#bom'), '1 SCD41\n2 heat-set inserts');
await page.fill('#bom', '3 WS2812 strip segment');
page.once('dialog', d => d.accept('Lamp'));
await page.click('#save');
await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.projects).some(p => p.name === 'Lamp'));
await page.waitForTimeout(100);
assert.equal(await page.inputValue('#bom'), '3 WS2812 strip segment');
// a long parts list (a KiCad export with footprints and datasheet links) is saved whole: it was cut to 4,000 characters
// on every load, mid-line, while the page said Saved
const longBom = Array.from({ length: 80 }, (_, i) => `1 R${i} 10k Resistor_SMD:R_0603_1608Metric https://example.com/datasheets/r${i}.pdf`).join('\n').slice(0, 5000);
assert.equal(longBom.length, 5000);
await page.fill('#bom', longBom);
page.once('dialog', d => d.accept('Long board'));
await page.click('#save');
await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('parts-bin')).items.projects).some(p => p.name === 'Long board'));
await page.fill('#bom', '3 WS2812 strip segment');
await page.reload(); await page.waitForSelector('#proj');
const longId = await page.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.projects).find(([, p]) => p.name === 'Long board')[0]);
await page.selectOption('#proj', longId);
assert.equal(await page.inputValue('#bom'), longBom, 'the saved BOM came back cut short');
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
// two lines for one part are checked together: each fits the stock alone, but not both (both said have, and the shopping
// list left them out); the shortfall is bought once
const bmeStock = await page.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-bme280'].qty);
await page.fill('#bom', `${bmeStock - 1} BME280\nBME280 x2\n1 SCD41`); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody td:last-child .chip', cs => cs.map(c => c.textContent)), ['short 1', 'short 1', 'have']);
assert.equal(await page.textContent('.bom-table tbody tr:first-child td:nth-child(2) .tiny:last-child'), `${bmeStock + 1} needed across 2 lines`);
assert.match(await page.textContent('.bom-summary'), /1 have.*2 short.*0 missing/);
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '1 × BME280');
// a guide's headings are rows over the lines after them, not missing parts in the summary or the shopping list
await page.fill('#bom', 'Electronics\n1 SCD41\nSGP30\nHardware Supplies\n2 heat-set inserts\nFor this build you’ll need:'); await page.click('#check');
assert.deepEqual(await page.$$eval('.bom-table tbody tr.sect th', ts => ts.map(t => [t.textContent, t.colSpan, t.scope])), [['Electronics', 5, 'colgroup'], ['Hardware Supplies', 5, 'colgroup'], ['For this build you’ll need', 5, 'colgroup']]);
assert.equal(await page.$$eval('.bom-table tbody tr:not(.sect)', rs => rs.length), 3);
assert.match(await page.textContent('.bom-summary'), /^2 have0 short1 missing$/);
// and the summary is said, as the table is drawn out of hearing below the button
await page.waitForFunction(() => document.getElementById('say').textContent === '2 have, 0 short, 1 missing', null, { timeout: 2000 }).catch(() => assert.fail('BOM check said nothing'));
await page.click('#out #copy');
await page.waitForFunction(() => window.__shared === '1 × SGP30');
await page.fill('#bom', '0.3 m heat shrink tubing 3mm'); await page.click('#check'); // the list the clipboard check uses later

// ---- Inbox: a link from Claude brings parts to check; each is saved and tagged from its card
const IN = await import('../js/inbox.js');
const part = id => page.evaluate(id => JSON.parse(localStorage.getItem('parts-bin')).items.parts[id], id);
const partNamed = name => page.evaluate(name => Object.entries(JSON.parse(localStorage.getItem('parts-bin')).items.parts).map(([id, x]) => ({ id, ...x })).find(x => x.name === name), name);
const tapTag = async () => { await page.waitForSelector('#tz.wait'); await page.evaluate(() => window.__tap()); await page.waitForFunction(() => !document.querySelector('.sheet')); };
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
// skipping takes a card out and saves nothing
await page.click('.card.inb[data-k="i2"] [data-a="skip"]');
await page.waitForSelector('text=Nothing waiting');
assert.equal(await page.locator('#tabbar .badge').count(), 0);
assert.equal(await partNamed('Unmarked purple board'), undefined);
// the same link again, on a fresh load, doesn't bring the batch back unless asked
await page.goto('about:blank'); await page.goto(photoLink);
await page.waitForSelector('#again');
assert.equal(await page.locator('.card.inb').count(), 0);
await page.click('#again'); await page.waitForSelector('.card.inb');
assert.equal(await page.locator('.card.inb').count(), 3);
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
assert.deepEqual(await page.locator('.diff .k').allTextContents(), ['Part number', 'Interface', 'I2C address', 'Supply', 'Tags', 'Notes']);
await page.uncheck('.diff input[data-k="notes"]');
await page.click('[data-a="apply"]');
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
// nothing found is "No parts match.", not "No parts here yet"
await page.fill('#q', 'zzzz'); await page.waitForSelector('#main .empty:has-text("No parts match.")');
await page.fill('#q', ''); await page.waitForFunction(() => document.querySelectorAll('.item').length > 1);
await page.selectOption('#cat', '__low'); await page.waitForSelector('#main .empty:has-text("No parts match.")');
await page.selectOption('#cat', '');

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
// every field writes at 16 px on a phone, as Safari on an iPhone zooms the page in on a field with smaller writing as soon
// as it's tapped: search, Pack, BOM check, the Inbox, a part's count, and the part and bin sheets
const smallFields = () => page.evaluate(() => [...document.querySelectorAll('input:not([type=file]):not([type=checkbox]),select,textarea')].filter(e => e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.tagName));
for (const hash of ['#bins', '#scan', '#inbox', '#bom', '#part/p-scd41']) { await page.goto(base + hash); await page.waitForTimeout(150); assert.deepEqual(await smallFields(), [], hash + ': a field under 16 px'); }
await page.click('#edit'); await page.waitForSelector('#p-name'); await page.$eval('.sheet details.more', d => { d.open = true; }); assert.deepEqual(await smallFields(), [], 'the part sheet: a field under 16 px'); await page.click('.sheet #cancel');
await page.goto(base + '#bin/bin-env'); await page.click('#edit'); await page.waitForSelector('#f-code'); assert.deepEqual(await smallFields(), [], 'the bin sheet: a field under 16 px'); await page.click('.sheet #cancel');
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
// Save as project
await page.goto(base + '#bom'); await page.waitForSelector('#save');
await noToast(); page.once('dialog', d => d.accept('No room')); await page.click('#save'); await page.waitForSelector(FULL);
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
  await page.click('text=Bag tag'); await page.click('.sheet #write'); await page.waitForSelector('#tz.wait');
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
await aiCtx.route('https://api.anthropic.com/**', r => (r.request().method() === 'OPTIONS'
  ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } })
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
// with nothing in the inventory yet: Parts points at Pack (it used to be "Scan in"), and the Inbox doesn't say every part
// has details
await ai.goto(base + '#parts'); assert.match(await ai.textContent('#main .empty'), /^No parts here yet\. Add one, or use Pack/);
await ai.goto(base + '#inbox'); await ai.waitForSelector('text=Fill in details');
assert.equal(await ai.locator('text=Every part has some details already').count(), 0);
await aiCtx.close();

// ---- in a browser that can't write tags, a bag's tag sheet says tags need Chrome on Android and offers the link to copy.
// (It used to offer Tag Along, which needs NFC too and didn't read the link it was given, and opening it took the number.)
const noNfcCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await noNfcCtx.addInitScript(d => { if (!localStorage.getItem('parts-bin')) localStorage.setItem('parts-bin', d); }, JSON.stringify({ app: 'parts-bin', v: 1, items: { bins: {}, parts: { 'p-loose': { name: 'Loose part', qty: 1, t: 1 } }, projects: {} } }));
await noNfcCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const noNfc = await noNfcCtx.newPage();
await noNfc.goto(base + '#part/p-loose');
assert.equal(await noNfc.evaluate(() => 'NDEFReader' in window), false);
await noNfc.click('text=Bag tag');
await noNfc.waitForSelector('.sheet #copy');
assert.equal(await noNfc.locator('.sheet a').count(), 0, 'a link out of the tag sheet');
assert.equal(await noNfc.textContent('.sheet #t-status'), 'Tags need Chrome on Android. Open Parts Bin there to write this one, or copy its link.');
assert.match(await noNfc.textContent('.sheet p.muted'), /The number is saved once its link is copied/);
const looseBag = () => noNfc.evaluate(() => JSON.parse(localStorage.getItem('parts-bin')).items.parts['p-loose'].bag);
await noNfc.click('.sheet #done'); assert.ok(!(await looseBag()), 'looking at the sheet took no number');
await noNfc.click('text=Bag tag'); await noNfc.click('.sheet #copy');
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
await tzCtx.close();

// ---- every control has a name a screen reader can say, a sheet is named by its heading, and toasts are announced
const named = async (hash, role, name) => { await page.goto(base + hash); assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1, `${hash}: a ${role} called "${name}"`); };
await named('#parts', 'searchbox', 'Search'); await named('#parts', 'combobox', 'Category');
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
await page.goto(base + '#bins'); await page.waitForSelector('.bin:has-text("Environmental") .photo svg');
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
  await page.click('.clashbar #showclash'); await page.waitForSelector('.item');
  assert.equal(await page.evaluate(() => location.hash), '#parts');
  assert.deepEqual(await page.locator('.item .t').allTextContents(), [tp.name, 'Buzzer module'], 'the part with the tag first');
  assert.equal(await page.locator('.item .chip:has-text("bag used twice")').count(), 2);
  assert.match(await page.textContent('.gapnote'), new RegExp(`On no part: #${pad(maxBag + 1)}\\.`));
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
  await page.click('.sheet #save'); await tapTag();
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
  assert.deepEqual(await pg.locator('#print-root tbody td').allTextContents(), ['#001', 'BME280 (Adafruit)', '3', 'ENV', '']);
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
  await sp.click('text=Bag tag'); await sp.click('.sheet #write'); await sp.waitForSelector('#tz.wait');
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
  await sp.click('text=Bag tag'); await sp.click('.sheet #write'); await sp.waitForSelector('#tz.wait');
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
  await rp.click('text=Bag tag'); await rp.click('.sheet #write'); await listening();
  await ioFail(); await rp.waitForSelector('#tz.bad');
  assert.equal(await rp.textContent('#t-status'), 'Didn’t take. Hold it flat and still: still listening.');
  // listening again with no tap, and the next hold writes it
  await listening();
  assert.ok(await rp.evaluate(() => window.__tap())); await rp.waitForSelector('#tz.ok');
  assert.match((await rp.evaluate(() => window.__written)).at(-1), /#bag\/012$/);
  await rp.waitForFunction(() => !document.querySelector('.sheet'));
  // it stops after five tries of its own, and says to tap
  await rp.click('text=Bag tag'); await rp.click('.sheet #write'); await listening();
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
  await fp.goto(base + '#part/p-12'); await fp.waitForSelector('text=Bag tag');
  await fp.focus('text=Bag tag'); await fp.keyboard.press('Enter'); await fp.waitForSelector('.sheet #write');
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
  // said on the next frame, once the card has gone
  await ip.waitForFunction(() => document.getElementById('say').textContent === 'Skipped Rotary encoder', null, { timeout: 2000 }).catch(() => assert.fail('Skip didn’t say what it skipped'));
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
  await np.click('text=Bag tag'); await np.click('.sheet #copy');
  await np.waitForSelector('.sheet textarea');
  assert.equal(await np.inputValue('.sheet textarea'), base + '#bag/002'); assert.equal((await got('p-loose')).bag, 2);
  await np.click('.sheet #done');

  // a box is called a box: + Box opens "New box" (it said "New bin", then "Bin added"), and the title follows the Type
  await np.goto(base + '#scan'); await np.click('#newbox'); await np.waitForSelector('.sheet #f-kind');
  assert.equal(await np.evaluate(() => document.activeElement.id), 'f-code', 'on a laptop the first field has the keyboard');
  assert.equal(await np.textContent('.sheet h3'), 'New box');
  await np.selectOption('#f-kind', 'bin'); assert.equal(await np.textContent('.sheet h3'), 'New bin');
  await np.selectOption('#f-kind', 'box'); assert.equal(await np.textContent('.sheet h3'), 'New box');
  await np.click('.sheet #save'); await np.waitForSelector('#toast:has-text("Box added")');
  await np.waitForFunction(() => location.hash.startsWith('#bin/') && !document.querySelector('.sheet'));
  await np.click('#edit'); assert.equal(await np.textContent('.sheet h3'), 'Edit box'); assert.equal(await np.textContent('.sheet #del'), 'Delete box');
  await np.click('.sheet #cancel');
  // a bin's printed list counts parts, and deleting it says what happens to them, in words (it said "part(s)")
  await np.goto(base + '#bin/b01'); await np.evaluate(() => { window.print = () => {}; }); await np.click('#print');
  assert.match(await np.textContent('#print-root .sub'), / · 1 part · /);
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
  assert.equal(await enter('555', 'Edit part'), '555 timer', 'and a number that’s the whole name, its part'); await kp.click('.sheet #cancel');
  // Parts: a number in the search is a bag only as the whole number, and a bag number on its own still lists that bag first
  await kp.goto(base + '#parts'); await kp.waitForSelector('.list .item');
  const found = async q => { await kp.fill('#q', q); await kp.waitForTimeout(400); return kp.locator('#main .list .item .t').allTextContents(); };
  assert.deepEqual(await found('nema 17'), []);
  assert.deepEqual(await found('nema 117'), ['NEMA 23 stepper motor'], 'its own bag number with a word finds it');
  assert.equal((await found('117'))[0], 'NEMA 23 stepper motor'); assert.equal((await found('#117'))[0], 'NEMA 23 stepper motor');
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
  // Pack's list: no trailing " · " on a box with no name, and the two told apart
  await tp.goto(base + '#scan'); await tp.waitForSelector('#dest');
  assert.deepEqual(await tp.$$eval('#dest option', os => os.slice(1).map(o => o.textContent)), ['BOX 01 · 0 bags', 'BOX 01 · 1 bag', 'C1 · Cables']);
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
  assert.deepEqual(await tp.$$eval('#dest option', os => os.slice(1).map(o => o.textContent)), ['BOX 01', 'BOX 02 · Kitchen stuff', 'C1 · Cables']);
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
