// Reading parts in the page with the person's own API key: a photo of bags or a bench, a receipt or order screenshot,
// and details for parts already listed. What comes back is made into an ordinary batch and goes through IN.cleanBatch,
// the same door as a link from Claude, so it lands in the Inbox with the same cards, limits and checks. No page code in
// this file (the fetch is in ai.js), so tests run it in Node.
//
// The answer is held to a JSON schema (structured outputs, output_config.format) rather than a forced tool call: the
// default model, claude-sonnet-5-5, refuses a forced tool_choice, and the schema gives the same always-valid JSON.

import * as IN from './inbox.js';

export const MODES = ['bags', 'receipt', 'details'];
export const MATCH_MIN = 0.7;      // a match Claude is less sure of than this goes in `check` as "might be …"
export const MAX_INV = 800;        // parts sent in the cached inventory list, most recently changed first
export const DETAILS_CHUNK = 20;   // parts asked about in one details request
// The default model thinks before it answers, and that counts against max_tokens, so these are well above the length of
// an answer. Only what's used is billed. A reply cut off is asked for once more at double (see ai.js).
export const MAX_TOKENS = { one: 8000, many: 16000 };

const SOURCE = { bags: 'photo', receipt: 'receipt', details: 'details' };
const LABEL = { bags: 'Photo', receipt: 'Receipt', details: 'Details' };

const str = { type: 'string' }, strs = { type: 'array', items: str };
// The fields js/inbox.js already takes, and `box` for Pack's picture cut from the photo. Every object says
// additionalProperties: false, as structured outputs require.
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'left_out'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'details mode only: the id of the part being described' },
          match: { type: 'string', description: 'inventory id when this is a part already listed' },
          matchConfidence: { type: 'number', description: '0 to 1' },
          name: str, category: str, mpn: str,
          qty: { type: 'number' }, unit: str,
          iface: strs, addr: str, volts: str, logic: str,
          tags: strs, notes: str, check: str,
          box: { type: 'array', items: { type: 'number' }, description: '[left, top, right, bottom] round this part, as fractions of the image, 0 to 1' },
        },
      },
    },
    left_out: { type: 'array', items: str, description: 'lines or things seen but not added, and why' },
  },
};

// The rules, in the parts-bin-cataloger skill's own words where it has them, so the app and the skill agree.
export const RULES = `You catalog parts into Parts Bin, Mark's parts inventory for his maker's workroom: bins, numbered bags with NFC tags, and a BOM check. Your answer becomes a batch in Parts Bin's Inbox, where each part is a card he checks before saving. Nothing reaches the inventory without his tap.

Accuracy over completeness. A wrong part number on a bag is worse than a blank. Never invent a marking, a count, an address, a voltage or a web address. Blank beats wrong. Flag doubts in "check"; don't settle them silently.

Photos of parts (mode "bags"): count the bags or items in the frame; each one ends up in "items" or in "left_out". For each, read in this order of trust: the seller's label on the bag, the silkscreen name on the board ("GY-BME280", "HW-611", "XL6019"), the marking on the main chip, then the layout. Count the pieces if they're all visible; if they're stacked or hidden, leave "qty" out and say so in "check". Several of one part are one item with their count, never two items.

Receipts, invoices, order screenshots (mode "receipt"): one part per line item. "qty" is packs × pieces per pack ("5pcs" in the title means 5). Leave out shipping, tax and things that aren't parts, and say what you left out in "left_out". Prices aren't stored.

Naming, so records match his: the part, then the brand in brackets when there is one. "BME280 (Adafruit)", "XL6019 5A step-up (ACEIRMC)", "HW611 (BMP280)", "KY040 rotary encoder". No-name clones get the tag "generic".

Is it one he already has? If it's the same physical part as an inventory record, set "match" to that id and "matchConfidence" to how sure you are, 0 to 1. Same chip on a different maker's board is a different part. Below 0.7, it's a guess: say so in "check" instead.

The fields, and only these:
- name: as above.
- category: one of the categories in use (listed with the inventory); a new one only when nothing fits. Tools go in Tools, spools in Filament, half-built things in Projects.
- qty, unit: count seen or bought; unit only when it isn't pieces ("m", "g").
- mpn: the main chip or the maker's part number, only from a visible marking or a well-known module name ("BME280", "TP4056"), else leave it out.
- iface: how you talk to it: I2C, SPI, UART, 1-Wire, I2S, Analog, Digital, PWM, USB, CAN, RS-485. A list. Leave out for things with no signal (regulators, connectors).
- addr: I2C address, default first: "0x76, 0x77", or a range "0x48–0x4B". From the chip when it's well known; an address you'd have to guess is left out, with a "check".
- volts: supply range of the board as sold: "3.3–5 V". For power modules, the input: "4–40 V in". Just the value.
- logic: signal level: "3.3 V", "5 V", "3.3 V or 5 V" (shifted on board), "5 V tolerant". Just the value.
- tags: lowercase, at most 4.
- notes: one short line of facts that fit nowhere above ("8-channel I2C mux").
- check: what to verify before trusting the record, as the test and its result, in under about 140 characters.
There are no links or reference photos: leave those to a chat with Claude.

Specs for well-known chips can come from what you know (a BME280's addresses, an SCD41's supply range). A clone board's regulator and level shifting vary: if the photo doesn't show them, give the chip's own range and say so in "check".

Set "check" when:
- it's a known lookalike: BME280 / BMP280 (HW-611 and "GY-BME280" boards are often BMP280), SHT30 / SHT40, VL53L0X / VL6180X, MPU-6050 / 6500 / 9250, NeoPixel RGB / RGBW, MAX98357 clones, TP4056 with or without the protection chips, buck or boost modules that share a board outline;
- the marking is hidden, sanded off or out of focus and you went by layout;
- a count is a guess;
- a wrong assumption would damage something: 5 V-only logic into a 3.3 V board, relay boards, an adjustable regulator whose output hasn't been set.
Mark's handheld tester is Bench Identifier: Port A names I2C chips by their ID (BMP280, BME280, SHT3x/4x, SCD40/41, MPU6050, VL53L0X, ADS1115 and more) or by address (BH1750, SSD1306 OLED, 1602 LCD backpack); Port B tests DHT11/22, NeoPixel RGB/RGBW, encoders, HC-SR04, I2S mics and amps; regulators, chargers and level shifters are a meter job. Write a check like "Bench Identifier Port A: ID 0x60 at 0xD0 is a BME280, 0x58 a BMP280." or "Meter: set the output before connecting a load."

Details (mode "details"): for each part you're given, propose only fields that are missing or plainly wrong. Give each item the part's "id" and just the fields you're proposing. Never "qty", never "name". A part with nothing to add isn't in "items". Categories: fill in blank ones, and move a part only when its category is plainly wrong.

"box" (photos only): the smallest rectangle round each part, all its pieces, as [left, top, right, bottom] fractions of the image's width and height from its top left corner. Leave it out if you can't place it.`;

// ---- the inventory, as one cached block
const cell = v => String(v ?? '').replace(/[|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
const changed = p => { const t = Date.parse(p?.updatedAt || ''); return Number.isFinite(t) ? t : 0; };
// parts: [{id, name, category, binId, qty, mpn, updatedAt}]; bins: Map or object of id → {code}
export function inventoryText(parts, bins = {}) {
  const code = id => (bins instanceof Map ? bins.get(id) : bins[id])?.code || '';
  const all = [...parts].filter(p => p && p.id && p.name);
  const sent = all.sort((a, b) => changed(b) - changed(a)).slice(0, MAX_INV);
  const cats = [...new Set(all.map(p => p.category).filter(Boolean))].sort();
  const rows = sent.map(p => [p.id, p.name, p.category, code(p.binId), p.qty ?? 0, p.mpn].map(cell).join(' | '));
  return `Categories in use: ${cats.length ? cats.join(', ') : 'none yet'}.
Inventory, ${rows.length === all.length ? (rows.length === 1 ? 'one part' : `all ${rows.length} parts`) : `the ${rows.length} most recently changed of ${all.length} parts`}:
id | name | category | bin | qty | mpn
${rows.join('\n') || '(nothing yet)'}`;
}

// What a details request says about each part: what it has already, so only what's missing comes back.
export function detailsRow(p, binCode = '') {
  const r = { id: p.id, name: p.name };
  for (const k of ['category', 'mpn', 'addr', 'volts', 'logic', 'check']) if (p[k]) r[k] = p[k];
  for (const k of ['iface', 'tags']) if ((p[k] || []).length) r[k] = p[k];
  if (p.notes) r.notes = String(p.notes).slice(0, 140);
  if (binCode) r.bin = binCode;
  return r;
}

export function maxTokens(mode, where = 'inbox') { return mode === 'bags' && where === 'pack' ? MAX_TOKENS.one : MAX_TOKENS.many; }
// The long edge a photo is sent at: small print on a receipt or a bench of parts needs more than one bag does.
export function imageEdge(mode, where = 'inbox') { return mode === 'bags' && where === 'pack' ? 1280 : 1600; }

// Models that take the server-side fallback for a declined request (the beta's "default" form).
const FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1'];
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const wantsFallback = model => FALLBACK_MODELS.includes(model);

// One request body. image: {media_type, data} (base64), or null. structured: false asks for the JSON in the text instead,
// for a model that doesn't take output_config.format (see ai.js).
export function request({ model, mode, inventory, image = null, bin = '', desc = '', parts = [], max = MAX_TOKENS.many, structured = true, fallback = false }) {
  if (!MODES.includes(mode)) throw new Error('mode ' + mode);
  const ask = [`Mode: ${mode}.`];
  if (mode === 'bags') {
    if (bin) ask.push(`He is packing into bin ${bin}.`);
    if (image) ask.push('The photo shows bagged parts, labels, packaging or silkscreen. It may show several different parts: list each once, the largest or most central first, with a "box" for each.');
    if (desc) ask.push(`His description: "${String(desc).slice(0, 300)}".`);
  } else if (mode === 'receipt') ask.push('The image is a receipt, invoice or order page. One item per line item.');
  else ask.push(`The parts to fill in, with what each has already (JSON): ${JSON.stringify(parts)}`);
  if (!structured) ask.push(`Reply with only a JSON object with "items" and "left_out", in this schema, and no other text: ${JSON.stringify(SCHEMA)}`);
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type || 'image/jpeg', data: image.data } });
  content.push({ type: 'text', text: ask.join('\n') });
  const body = {
    model, max_tokens: max,
    // the rules, then the inventory; the inventory is the long part and the same through a packing session, so it's cached
    system: [{ type: 'text', text: RULES }, { type: 'text', text: inventory, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  };
  if (structured) body.output_config = { format: { type: 'json_schema', schema: SCHEMA } };
  if (fallback) body.fallbacks = 'default';
  return body;
}

// ---- reading the reply
// A reply's text, read as the JSON object. A reply cut off (stop_reason max_tokens) is read as far as it goes: every item
// that's complete is kept.
export function readText(text) {
  const s = String(text || '').trim();
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s), body = m ? m[1] : s.slice(Math.max(0, s.indexOf('{')));
  try { const j = JSON.parse(body); if (j && typeof j === 'object') return { data: j, whole: true }; } catch {}
  return { data: salvage(body), whole: false };
}
// The complete objects in the "items" array of a JSON text that stops part way.
export function salvage(text) {
  const out = { items: [], left_out: [] };
  const at = /"items"\s*:\s*\[/.exec(text); if (!at) return out;
  let i = at.index + at[0].length, depth = 0, start = -1, inStr = false, esc = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}') { if (--depth === 0 && start >= 0) { try { out.items.push(JSON.parse(text.slice(start, i + 1))); } catch {} start = -1; } }
    else if (c === ']' && depth === 0) break;
  }
  return out;
}
// The text blocks of a Messages API reply (thinking blocks, which come back empty, are skipped).
export const replyText = j => (j?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('');

// ---- what went wrong, in the app's words
const CREDITS = /credit balance|out of credits|insufficient (credit|funds|balance)|billing|spend limit|usage limit/i;
export function errorFor(status, message = '') {
  const m = String(message || '');
  if (CREDITS.test(m)) return { code: 'no_credits', message: 'Out of API credits until next month. Sending the photo to Claude in a chat still works.' };
  if (status === 401) return { code: 'not_granted', message: 'The API key was refused. Check it in Settings.' };
  if (status === 403) return { code: 'not_granted', message: m || 'The API key isn’t allowed to do that. Check it in Settings.' };
  if (status === 429) return { code: 'rate_limited', message: 'Too many requests. Wait a moment.' };
  if (status === 529 || /overloaded/i.test(m)) return { code: 'busy', message: 'Anthropic’s API is busy. Try again in a minute.' };
  return { code: 'error', message: m || 'The API answered ' + status };
}
// A 400 that says the model doesn't take structured outputs (or the schema), or the fallback: the request is sent again
// without it.
export const refusesFormat = m => /output_config|output_format|json_schema|structured output|schema/i.test(String(m || ''));
export const refusesFallback = m => /fallback/i.test(String(m || ''));

// ---- turning what was read into a batch
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const joinCheck = (a, b) => (!a ? b : !b || a.includes(b) ? a : a + ' · ' + b);
const pad = n => String(n).padStart(2, '0');
export function batchName(mode, d = new Date()) {
  const h = d.getHours(), t = `${(h + 11) % 12 + 1}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
  return `${LABEL[mode]}, ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${t}`;
}
export const madeDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The items as Parts Bin should take them, in order: a match only when Claude was sure enough (and the id is one it has),
// the same part twice made one with the counts added, no link or reference photo (the app can't browse, so a web address
// would be made up), and in details mode only the parts asked about, without a count or a new name. box is kept for
// Pack's picture and dropped by IN.cleanItem.
// names: Map of inventory id → name. asked: the ids a details request was about.
export function process(data, { mode, names = new Map(), asked = null }) {
  const raw = Array.isArray(data?.items) ? data.items.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
  const out = [], byKey = new Map();
  for (const x0 of raw) {
    const x = { ...x0 }; delete x.link; delete x.img; delete x.add; delete x.unsure;
    if (mode === 'details') {
      if (typeof x.id !== 'string' || !(asked ? asked.has(x.id) : names.has(x.id))) continue;
      delete x.qty; delete x.name; delete x.unit; delete x.match; delete x.matchConfidence; delete x.box;
      const key = 'id:' + x.id, was = byKey.get(key);
      if (was) { for (const [k, v] of Object.entries(x)) if (was[k] == null) was[k] = v; continue; } // the first one wins, as in the skill's script
      byKey.set(key, x); out.push(x); continue;
    }
    delete x.id;
    const conf = Number(x.matchConfidence);
    if (typeof x.match === 'string' && names.has(x.match)) {
      if (!(conf >= MATCH_MIN)) { x.check = joinCheck(x.check || '', `Might be ${names.get(x.match)}; check it’s the same part.`); delete x.match; }
    } else delete x.match;
    if (!x.match) delete x.matchConfidence;
    const key = x.match ? 'm:' + x.match : 'n:' + norm(x.name) + '|' + norm(x.mpn);
    const was = key !== 'n:|' && byKey.get(key);
    if (was) {
      if (typeof was.qty === 'number' && typeof x.qty === 'number') was.qty += x.qty;
      else if (typeof x.qty === 'number' && was.qty == null) was.qty = x.qty;
      was.check = joinCheck(was.check || '', x.check || '') || undefined;
      for (const [k, v] of Object.entries(x)) if (was[k] == null && v != null) was[k] = v;
      continue;
    }
    byKey.set(key, x); out.push(x);
  }
  return out;
}
// The batch, through the same door as a link from Claude. null when nothing in it is usable.
export function toBatch(items, { mode, bin = '', now = new Date() }) {
  return IN.cleanBatch({ partsbin: 1, batch: { id: 'ai' + now.getTime().toString(36), name: batchName(mode, now), made: madeDay(now), source: SOURCE[mode], bin, items } });
}
