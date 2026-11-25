// Reading parts in the page: the request it sends, what a reply becomes, and what goes wrong.  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PID from '../js/photoid.js';
import * as IN from '../js/inbox.js';
import { ONE, FIVE, RECEIPT, DETAILS } from './fake-anthropic.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const names = new Map([['p-bme280', 'BME280 (Adafruit)'], ['p-scd41', 'SCD41'], ['p-tca', 'TCA9548A I2C multiplexer'], ['p-loose', 'Loose module'], ['p-bare2', 'OLED'], ['p-other', 'Other']]);

test('the request: rules and a cached inventory, the answer held to the schema, and room to answer for each mode', () => {
  const inventory = PID.inventoryText([{ id: 'p-bme280', name: 'BME280 (Adafruit)', category: 'Sensors', binId: 'b1', qty: 5, mpn: 'BME280' }], { b1: { code: 'ENV' } });
  assert.match(inventory, /^Categories in use: Sensors\./);
  assert.match(inventory, /\np-bme280 \| BME280 \(Adafruit\) \| Sensors \| ENV \| 5 \| BME280$/);
  const image = { media_type: 'image/jpeg', data: 'AAAA' };
  const pack = PID.request({ model: 'claude-sonnet-5-5', mode: 'bags', inventory, image, bin: 'ENV', max: PID.maxTokens('bags', 'pack') });
  assert.equal(pack.system.length, 2);
  assert.equal(pack.system[0].text, PID.RULES); assert.equal(pack.system[0].cache_control, undefined);
  assert.deepEqual(pack.system[1], { type: 'text', text: inventory, cache_control: { type: 'ephemeral' } }, 'the inventory is the cached block');
  assert.deepEqual(pack.output_config, { format: { type: 'json_schema', schema: PID.SCHEMA } });
  assert.equal(pack.tool_choice, undefined, 'no forced tool: the default model refuses one');
  assert.equal(pack.max_tokens, 8000);
  assert.deepEqual(pack.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  assert.match(pack.messages[0].content[1].text, /^Mode: bags\.\nHe is packing into bin ENV\./);
  // what changes from one photo to the next is after the cached prefix: the inventory block is the same for each mode
  for (const mode of PID.MODES) {
    const r = PID.request({ model: 'm', mode, inventory, image: mode === 'details' ? null : image, parts: [{ id: 'p-bme280', name: 'BME280' }], max: PID.maxTokens(mode) });
    assert.deepEqual(r.system, pack.system); assert.equal(r.max_tokens, 16000, mode);
  }
  assert.equal(PID.imageEdge('bags', 'pack'), 1280); assert.equal(PID.imageEdge('receipt'), 1600); assert.equal(PID.imageEdge('bags'), 1600);
  // every object in the schema says additionalProperties: false, as structured outputs require
  const objects = []; (function walk(s) { if (s && typeof s === 'object') { if (s.type === 'object') objects.push(s); Object.values(s).forEach(walk); } })(PID.SCHEMA);
  assert.ok(objects.length >= 2 && objects.every(o => o.additionalProperties === false));
  // the fallback for a declined request, on the models that take it; text JSON for a model without structured outputs
  assert.equal(PID.request({ model: 'claude-sonnet-5-5', mode: 'bags', inventory, fallback: PID.wantsFallback('claude-sonnet-5-5') }).fallbacks, 'default');
  assert.equal(PID.wantsFallback('claude-haiku-5-5'), false);
  const plain = PID.request({ model: 'old', mode: 'receipt', inventory, image, structured: false });
  assert.equal(plain.output_config, undefined); assert.match(plain.messages[0].content.at(-1).text, /Reply with only a JSON object/);
  assert.throws(() => PID.request({ model: 'm', mode: 'nope', inventory }));
});

test('the cached inventory holds at most 800 parts, the most recently changed first', () => {
  const parts = Array.from({ length: 900 }, (_, i) => ({ id: 'p' + i, name: 'Part ' + i, qty: 1, updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString() }));
  const text = PID.inventoryText(parts);
  const rows = text.split('\n').slice(3);
  assert.equal(rows.length, 800); assert.match(rows[0], /^p899 \|/); assert.match(rows.at(-1), /^p100 \|/);
  assert.match(text, /the 800 most recently changed of 900 parts/);
  assert.match(PID.inventoryText([]), /\(nothing yet\)/);
  assert.match(PID.inventoryText([{ id: 'x', name: 'Pipe | and\nnewline', qty: 1 }]), /\nx \| Pipe and newline \| /, 'a | in a name can’t make a column');
});

test('a reply becomes a batch the Inbox takes: sure matches only, one card for a part seen twice, no links or photos', () => {
  const items = PID.process(FIVE, { mode: 'bags', names });
  const b = PID.toBatch(items, { mode: 'bags', bin: 'ENV', now: new Date(2026, 10, 22, 19, 40) });
  assert.deepEqual(IN.cleanBatch({ partsbin: 1, batch: b }), { ...b, made: '2026-11-22' }, 'it goes through cleanBatch unchanged');
  assert.equal(b.name, 'Photo, 22 Nov 7:40 PM'); assert.equal(b.source, 'photo'); assert.equal(b.bin, 'ENV'); assert.equal(b.made, '2026-11-22');
  assert.equal(b.items.length, 5, 'the HW-611 seen twice is one card');
  const [bme, scd, tca, hw] = b.items;
  assert.equal(bme.match, 'p-bme280');
  assert.equal(scd.match, undefined, 'a match under 0.7 is dropped…'); assert.match(scd.check, /^Might be SCD41/, '…to a check');
  assert.equal(tca.link, undefined); assert.equal(tca.img, undefined, 'the app never makes up a web address');
  assert.equal(hw.qty, 6); assert.deepEqual(hw.iface, ['I2C', 'SPI']); assert.match(hw.check, /BMP280/);
  for (const x of b.items) assert.equal(x.box, undefined, 'the box is only for Pack’s picture');
  // a match to a part that isn't in the inventory is no match
  assert.equal(PID.process({ items: [{ name: 'X', match: 'p-nowhere', matchConfidence: 1 }] }, { mode: 'bags', names })[0].match, undefined);
  // one part, with everything the skill fills in
  const one = PID.toBatch(PID.process(ONE, { mode: 'bags', names }), { mode: 'bags' }).items[0];
  assert.deepEqual({ ...one, k: undefined }, { name: 'BME280 (Adafruit)', category: 'Sensors', mpn: 'BME280', iface: ['I2C', 'SPI'], addr: '0x77, 0x76', volts: '3–5 V', logic: '3.3 V or 5 V', match: 'p-bme280', qty: 2, k: undefined });
  // a receipt is a receipt batch, which adds to the counts
  const rec = PID.toBatch(PID.process(RECEIPT, { mode: 'receipt', names }), { mode: 'receipt' });
  assert.equal(rec.source, 'receipt'); assert.equal(rec.name.split(',')[0], 'Receipt'); assert.deepEqual(rec.items.map(x => x.qty), [4, 100]);
  // nothing usable is no batch
  assert.equal(PID.toBatch(PID.process({ items: [{}, 'x', null] }, { mode: 'bags', names }), { mode: 'bags' }), null);
  assert.equal(PID.toBatch(PID.process({}, { mode: 'bags', names }), { mode: 'bags' }), null);
});

test('details: only the parts asked about, never a count or a new name', () => {
  const reply = { items: Object.entries(DETAILS).map(([id, x]) => ({ id, ...x })).concat([{ id: 'p-loose', volts: 'ignored: the first one wins', logic: '3.3 V' }]) };
  const items = PID.process(reply, { mode: 'details', names, asked: new Set(['p-loose', 'p-bare2']) });
  const b = PID.toBatch(items, { mode: 'details' });
  assert.equal(b.source, 'details');
  assert.deepEqual(b.items.map(({ k, ...x }) => x), [
    { category: 'Sensors', mpn: 'BH1750', iface: ['I2C'], addr: '0x23, 0x5C', volts: '3–5 V', logic: '3.3 V', id: 'p-loose' },
    { category: 'Displays', iface: ['I2C'], addr: '0x3C', check: 'Bench Identifier Port A: an SSD1306-class OLED shows at 0x3C.', id: 'p-bare2' },
  ]);
  const row = PID.detailsRow({ id: 'p1', name: 'X', category: 'Sensors', iface: [], tags: ['a'], notes: 'n'.repeat(300), qty: 3, bag: 4 }, 'ENV');
  assert.deepEqual(row, { id: 'p1', name: 'X', category: 'Sensors', tags: ['a'], notes: 'n'.repeat(140), bin: 'ENV' });
});

test('a reply cut off keeps every part that was complete', () => {
  const text = JSON.stringify(FIVE).slice(0, JSON.stringify(FIVE).indexOf('HW-611') + 10);
  const { data, whole } = PID.readText(text);
  assert.equal(whole, false); assert.deepEqual(data.items.map(x => x.name), ['BME280 (Adafruit)', 'SCD41 CO2 sensor', 'TCA9548A I2C multiplexer']);
  assert.deepEqual(PID.readText(JSON.stringify(ONE)), { data: ONE, whole: true });
  assert.deepEqual(PID.readText('```json\n' + JSON.stringify(ONE) + '\n```').data, ONE, 'a model without structured outputs may fence it');
  assert.deepEqual(PID.readText('{"items": [{"name": "a \\"}\\" b"}, {"na').data.items, [{ name: 'a "}" b' }], 'a brace inside a string isn’t the end');
  assert.deepEqual(PID.readText('Not JSON at all').data.items, []);
  assert.equal(PID.replyText({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
});

test('what went wrong, in the app’s words', () => {
  assert.deepEqual(PID.errorFor(401, 'invalid x-api-key'), { code: 'not_granted', message: 'The API key was refused. Check it in Settings.' });
  assert.deepEqual(PID.errorFor(429, 'rate_limit_error'), { code: 'rate_limited', message: 'Too many requests. Wait a moment.' });
  // credits used up: matched on the message, whatever the code
  for (const [status, m] of [[400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'], [402, 'Insufficient credit'], [403, 'You have reached your specified API usage limits.']])
    assert.deepEqual(PID.errorFor(status, m), { code: 'no_credits', message: 'Out of API credits until next month. Sending the photo to Claude in a chat still works.' }, m);
  assert.equal(PID.errorFor(529, 'Overloaded').code, 'busy');
  assert.deepEqual(PID.errorFor(500, ''), { code: 'error', message: 'The API answered 500' });
  assert.ok(PID.refusesFormat('output_config.format: Extra inputs are not permitted')); assert.ok(!PID.refusesFormat('max_tokens: too large'));
  assert.ok(PID.refusesFallback('fallbacks: not supported for this model'));
});

// The key lives only in the browser that was given it: none, real or a stand-in shaped like one, is in the repo.
test('no API key anywhere in the repo or the page', () => {
  const KEY = /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/;
  const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); if (['.git', 'node_modules'].includes(n)) return []; return statSync(p).isDirectory() ? walk(p) : [p]; });
  const hits = walk(root).filter(p => /\.(js|mjs|html|json|md|css|webmanifest|txt)$/.test(p) && KEY.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});
