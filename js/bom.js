// BOM check: reading a pasted parts list, and finding each line in the inventory. Search uses norm() too.
// No page code, so tests run it in Node.

// Lower case, with anything but letters, digits, dots and plus signs read as a space: "ESP32-S3" is "esp32 s3". Unicode
// is folded first, so CO₂ is co2 and a full-width ＥＳＰ３２ is esp32; µ (or μ) is u, so 100µF is 100uf; and an ohm after a
// number goes, as it's how a resistor's value is written, not what it's called: "10 kΩ" and "220 ohm" are 10k and 220.
export const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[µμ]/g, 'u')
  .replace(/(\d)\s*([km]?)\s*(?:ω|ohms?)(?![a-z])/g, '$1$2').replace(/[^a-z0-9.+]+/g, ' ').trim();

// One part per line (or per ;), with its count first or last: "2x XIAO ESP32-S3", "SCD41 ×1". Lines starting with # are
// skipped, a bullet in front is dropped, and a heading ("Hardware Supplies", "You'll need:") is marked heading: true. A name can start with a digit (1N4148, 74HC595, 18650 cells), so each way of
// writing a count says which side the count is on, and a marked count (2x, x8, ×2, ", 5") is believed before a bare
// number at the start: "18650 cells×2" is two 18650 cells. A size isn't a count: a pin header's 1x40 and a screw's M3x8
// are part of the name, spaced or not (Screws M3 x 10 is one size of screw). Nor is a long number before a single word,
// with no other count: "555 timer" is one 555. Nor is a number before its unit or a pin count: "220 ohm resistors", "100
// nF capacitor" and "4 pin JST" are one value of resistor, capacitor and connector.
const N = '(\\d+(?:\\.\\d+)?)';
const SIZE = /(^|\s)M?\d+(\.\d+)?\s*$/i; // what comes before the x of a size: a bare number (1x40) or an M size (M2.5x6)
const MSIZE = /(^|\s)M\d+(\.\d+)?\s*$/i; // the same with a space before the x: only an M size, as "18650 x 2" is two
const VALUE = /^(?:ohms?|Ω|[kK]Ω?|MΩ|[uUµμnNpP][fF]|mAh|mA|[vV]|mm|[kKmM]?Hz|pins?|ways?|positions?)(?![a-zA-Z0-9])/;
const COUNTS = [ // [pattern, the count's group, the name's group, unless(match) it's not a count after all]
  [new RegExp(`^${N}\\s*[x×*]\\s+(.+)$`, 'i'), 1, 2], // 2x name, 2 x name
  [new RegExp(`^(.+?)\\s+[x×*]\\s*${N}$`, 'i'), 2, 1, m => MSIZE.test(m[1])], // name x8, name × 2; not M3 x 10
  [new RegExp(`^(.+?)\\s*[,\\t]\\s*${N}$`), 2, 1], // name, 5 (or a tab, from a spreadsheet)
  // name×2, SCD41x2; not a size, and not a word that ends in x (Box2)
  [new RegExp(`^(.+?)(?:[×*]|(?<![a-z])x)\\s*${N}$`, 'i'), 2, 1, m => SIZE.test(m[1])],
  [new RegExp(`^${N}\\s+(.+)$`), 1, 2, m => (/^\d{3,}$/.test(m[1]) && !/\s/.test(m[2])) || VALUE.test(m[2])], // 3 name; not 555 timer or 220 ohm
];
export function parseBom(text) {
  return String(text || '').split(/\n|;/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/^[-•*]\s*/, '')).filter(Boolean).map(readLine);
}
function readLine(l) {
  if (/:$/.test(l)) return { qty: 1, name: l.slice(0, -1).trim(), heading: true };
  const d = designators(l);
  if (d) {
    // two or more are the count, unless one is given too, and so is one before a bare value, which they name the kind of:
    // "R1,R2,R3 10k" is three 10k resistors. One before anything else stays in the name as written (matchPart looks past it).
    const r = count(d.rest), kind = /^\d[\w.]*(?:\s*(?:ohms?|Ω))?$/i.test(r.name) ? d.kind : '';
    if (d.n > 1 || kind) return { ...r, qty: r.qty ?? d.n, name: kind ? `${r.name} ${kind}` : r.name };
  }
  const r = count(l);
  if (r.qty == null && isHeading(l)) return { qty: 1, name: l, heading: true };
  return { ...r, qty: r.qty ?? 1 };
}
// A heading over the parts in a guide's list: a line ending in a colon, or a short one of only words like these, with
// at least one that says what follows ("Hardware Supplies", "Shopping List", "What you need"). BOM check shows it over
// the lines after it, and doesn't look for it in the inventory.
const SAYS = new Set('supplies supply parts part list tools tool hardware electronics shopping need needed components materials bill'.split(' '));
const HEAD = new Set([...SAYS, ...'electronic component material of misc other and the for this build you ll your what s here required optional'.split(' ')]);
const isHeading = l => { const w = norm(l).split(' '); return w.length <= 6 && w.some(x => SAYS.has(x)) && w.every(x => HEAD.has(x)); };
function count(l) {
  l = l.replace(RANGE, '');
  for (const re of MEASURES) {
    const m = re.exec(l); if (!m) continue;
    const { q, u, name } = m.groups, [unit, per] = TO_BASE[u];
    return { qty: Number((Number(q) * per).toPrecision(12)), unit, name: name.trim() };
  }
  for (const [re, q, n, unless] of COUNTS) { const m = re.exec(l); if (m && !unless?.(m)) return { qty: Number(m[q]), name: m[n].trim() }; }
  return { qty: null, name: l };
}
// A count with a unit, in metres, grams or feet (cm and mm are read as m, kg as g), before the name or after it, glued
// or spaced: "2m of wire", "30 g solder", "WS2812B strip 0.5m", "heat shrink 3mm, 30cm", "LED strip (1 m)". In lower
// case only, so 4G and a 4.7M resistor aren't any. Millimetres only before "of" ("500mm of heat shrink"), as a 5mm LED
// and heat shrink 3mm are sizes. A range is the most it could need: "4-6 M3x8 screws" is six.
const Q = '(?<q>\\d+(?:\\.\\d+)?)', LEN = '(?<u>m|cm|g|kg|ft)';
const MEASURES = [
  new RegExp(`^${Q}\\s*${LEN}\\s+(?:of\\s+)?(?<name>\\S.*)$`), // 2m of wire, 0.5 m LED strip
  new RegExp(`^${Q}\\s*(?<u>mm)\\s+of\\s+(?<name>\\S.*)$`), // 500mm of heat shrink
  new RegExp(`^(?<name>.+?)\\s*\\(\\s*${Q}\\s*${LEN}\\s*\\)$`), // LED strip (1 m)
  new RegExp(`^(?<name>.+?)(?:\\s*,\\s*|\\s+)${Q}\\s*${LEN}$`), // WS2812B strip 0.5m, heat shrink 3mm, 30cm
];
const TO_BASE = { m: ['m', 1], cm: ['m', 0.01], mm: ['m', 0.001], ft: ['ft', 1], g: ['g', 1], kg: ['g', 1000] };
const RANGE = /^\d+(?:\.\d+)?\s*[-–]\s*(?=\d+(?:\.\d+)?(?:\s*(?:m|cm|mm|g|kg|ft|[x×*]))?\s+(?!(?:pins?|ways?|positions?)(?![a-z])))/i;

// Designators: the names a schematic gives each part on the board (R1, C2, D1-D4, LED1, U1), in a run at the start of a
// line, by commas or spaces. Only the usual letters, in capitals, and each ends where its number does, so DHT22, SCD41,
// L298N and R2D2 aren't any. n: how many (D1-D4 is four); kind: what all R, C, L or D are, which a bare value after them
// (220, 100nF, 1N4148) needs to be found, as a list that says "R4, R5 220" never says resistor.
const DES = '(?:LED|SW|IC|BT|TP|FB|RV|VR|CN|JP|LS|BZ|DS|RN|R|C|L|D|Q|U|J|P|K|F|Y)\\d+(?![A-Za-z0-9])';
const DES_RUN = new RegExp(`^(${DES}(?:\\s*[-–]\\s*${DES})?(?:(?:\\s*,\\s*|\\s+)${DES}(?:\\s*[-–]\\s*${DES})?)*)\\s*,?\\s+(\\S.*)$`);
const KINDS = { R: 'resistor', C: 'capacitor', L: 'inductor', D: 'diode' };
function designators(l) {
  const m = DES_RUN.exec(l); if (!m) return null;
  let n = 0; const letters = new Set();
  for (const [, a, from, to] of m[1].matchAll(/([A-Z]+)(\d+)(?:\s*[-–]\s*[A-Z]+(\d+))?/g)) { letters.add(a); n += to ? Math.max(1, Math.min(999, to - from + 1)) : 1; }
  return { n, rest: m[2].trim(), kind: letters.size === 1 && KINDS[[...letters][0]] || '' };
}

// A part number is a word with letters and digits, four characters or more: SCD41, 1N4148, ESP32, 3.3V. A number with a
// unit isn't one (100uF, 40pin, 1000mAh, 2.54mm): those are written so many ways ("40pin", "40 pin") that they can't rule a
// part out. A voltage is one, though, since a 3.3V regulator isn't a 5V one. Takes a word from norm().
const UNIT = /^\d+(\.\d+)?[a-z]+$/, VOLTS = /^\d+(\.\d+)?v$/;
export const isPartNumber = w => w.length >= 4 && /[a-z]/.test(w) && /\d/.test(w) && (!UNIT.test(w) || VOLTS.test(w));

// The words a name is matched on, from norm(). Each is read in the singular (screws is screw, boxes is box: a word of four
// letters or more, so bus and gps stay as they are). A pin count is one word however it's written (4-pin, 4 pin, 4 way, 4
// position are all 4pin), and so is a screw size (M3 x 8mm, M3 x 8 and M3x8 are m3x8), and a value with its unit (100 uF
// is 100uf). A word of one letter is dropped, unless it follows a word as a model's letter does (Pico W, wires M-F).
const UNITS = 'uf|nf|pf|k|m|mm|cm|v|mv|ma|mah|w|hz|khz|mhz|ghz|awg|g|kg|ft';
const singular = w => w.length < 4 || !/^[a-z]+$/.test(w) ? w : /(?:ss|x|ch|sh)es$/.test(w) ? w.slice(0, -2) : /[^sui]s$/.test(w) ? w.slice(0, -1) : w;
export function words(s) {
  const raw = norm(s)
    .replace(/(^| )(\d+) ?(?:pins?|ways?|positions?)(?![a-z0-9])/g, '$1$2pin')
    .replace(/(^| )m(\d+(?:\.\d+)?) ?x ?(\d+(?:\.\d+)?)(?: ?mm)?(?![a-z0-9.])/g, '$1m$2x$3')
    .replace(new RegExp(`(^| )(\\d+(?:\\.\\d+)?) (${UNITS})(?= |$)`, 'g'), '$1$2$3')
    .split(' ').filter(Boolean);
  return raw.flatMap((w, i) => w.length > 1 ? [singular(w)] : /^[b-wyz]$/.test(w) && /[a-z]/.test(raw[i - 1] || '') ? [w] : []);
}

// A value or a variant: a number with a unit (1k, 4.7k, 100uf, 3mm, 4pin), a short code with a digit (C3, S3, M3) or a
// model's letter (the W of Pico W). A part without one the line has may still be the part, but isn't sure to be (a 10k
// resistor for "1k resistor", an ESP32-S3 for "ESP32-C3", a Pico for a Pico W), so it matches no better than fuzzy.
const isValue = w => UNIT.test(w) || (w.length <= 3 && /\d/.test(w) && /[a-z]/.test(w)) || w.length === 1;
const FUZZY = 0.75; // under BOM check's 0.8 for a sure match

// What a part can be found by: the words of its name, part number and tags, each pair of neighbours run together (lock
// nut is also locknut, ESP32 S3 also esp32s3), and a screw size's own pieces (m3x8 is also m3), each with the words it
// came from. Kept for each part until its name, part number or tags change.
const known = new WeakMap();
function index(p) {
  const key = [p.name, p.mpn, (p.tags || []).join(' ')].join(' ; '), had = known.get(p);
  if (had?.key === key) return had;
  const all = words(key), forms = new Map(), add = (f, from) => { if (!forms.has(f)) forms.set(f, from); };
  all.forEach((w, i) => {
    add(w, [w]);
    const sz = /^(m\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(w); if (sz) { add(sz[1], [w]); add(sz[2], [w]); }
    if (all[i + 1]) add(w + all[i + 1], [w, all[i + 1]]);
  });
  const x = { key, forms, name: [...new Set(words(p.name))] }; known.set(p, x); return x;
}
// The words of a part that a word of the line finds, or null. A short word (three characters or fewer) needs a whole
// word: an LED isn't an OLED, a 2k isn't a 1.2k, and M3 isn't in LM358. But three letters can start a word (cap,
// capacitor; pot, potentiometer), and a number can be a part number's (555 in NE555). A longer word can sit inside one,
// at its start if it's all letters (switch, switches; lock, locknut; so male isn't in female), or anywhere a part
// number's digits aren't cut through (7805 in LM7805, WS2812 in WS2812B, but not M3x8 in M3x80).
function find(w, x) {
  if (x.forms.has(w)) return x.forms.get(w);
  if (w.length < 3) return null;
  const digits = /\d/.test(w), number = /^\d+$/.test(w);
  if (digits && !number && w.length === 3) return null;
  for (const [f, from] of x.forms) {
    if (!digits) { if (f.startsWith(w)) return from; continue; }
    for (let i = f.indexOf(w); i >= 0; i = f.indexOf(w, i + 1)) {
      const before = f[i - 1] || '', after = f[i + w.length] || '';
      if (/[\d.]/.test(after) || /[\d.]/.test(before) || (number && !/[a-z]/.test(before))) continue;
      return from;
    }
  }
  return null;
}

// The part a line most likely means: the one whose name, part number and tags hold the most of the line's words, counted
// by length, with part numbers counted twice. A line that names a part number only matches a part that has one of them,
// and a part that has one always matches, at a share of at least 0.6: "SCD41 breakout" is the SCD41, and "BME280
// breakout" isn't a BMP280 breakout. A line of plain words needs at least half of them. conf is the share, at most
// FUZZY for a part without one of the line's values or variants, and such a part is only picked over one with them when
// it holds a quarter more of the line: "JST-PH 2-pin female" is the 2-pin cable before the 3-pin female one. Of two parts
// that hold as much of the line, the one with fewer other words in its name wins: "Pi Pico" is the Pico, not the Pico W.
// A designator in front ("LED1 5mm red LED", "U1 NE555") is looked past, but tried too ("D1 mini", "C3 SuperMini").
export function matchPart(name, parts) {
  parts = [...parts];
  const all = bestPart(name, parts), d = designators(String(name || ''));
  if (!d) return all;
  const past = bestPart(d.rest, parts);
  return !all || (past && past.conf > all.conf) ? past : all;
}
function bestPart(name, parts) {
  const t = words(name); if (!t.length) return null;
  const weight = w => (isPartNumber(w) ? 2 : 1) * w.length, all = t.reduce((n, w) => n + weight(w), 0);
  const numbered = t.some(isPartNumber), values = t.filter(isValue);
  let best = null, bs = 0, br = -1, bx = Infinity;
  for (const p of parts) {
    const x = index(p), hit = new Set(), got = t.map(w => find(w, x));
    // two words of the line can be one of the part's: lock nut for locknut
    for (let i = 0; i < t.length - 1; i++) if (!got[i] || !got[i + 1]) { const f = find(t[i] + t[i + 1], x); if (f) got[i] = got[i + 1] = f; }
    let s = 0, shared = false;
    t.forEach((w, i) => { if (!got[i]) return; s += weight(w); if (isPartNumber(w)) shared = true; for (const h of got[i]) hit.add(h); });
    let cov = s / all;
    if (numbered ? !shared : cov < 0.5) continue;
    const lacks = values.some(w => !x.forms.has(w)), rank = lacks ? cov - 0.25 : cov, extra = x.name.filter(w => !hit.has(w)).length;
    if (rank > br + 1e-9 || (rank > br - 1e-9 && extra < bx)) { br = rank; bx = extra; bs = lacks ? Math.min(cov, FUZZY) : cov; best = p; }
  }
  return best ? { p: best, conf: numbered ? Math.max(bs, 0.6) : bs } : null;
}

// How many more a line needs than there are, to the thousandth: 0.3 m wanted with 0.1 m in stock is short 0.2 (plain
// subtraction says 0.19999999999999998).
export const shortBy = (need, have) => Math.round((need - have) * 1000) / 1000;

// Lengths and weights: each unit as its kind's base (m or g) and how many of the base one is.
const PER = { m: ['m', 1], cm: ['m', 0.01], mm: ['m', 0.001], ft: ['m', 0.3048], g: ['g', 1], kg: ['g', 1000] };
const per = u => PER[String(u || '').trim().toLowerCase()];
const pieces = u => !u || u === 'pcs';
// A line's count in its part's unit, to the thousandth: 10 ft of a wire kept in metres is 3.048, 50 cm is 0.5. A line
// with no unit is in the part's, and one in a unit that can't become the part's (2 m of a part counted in pieces) is
// taken as written.
export function inPartUnit(r) {
  const from = per(r.unit), to = per(r.m?.p.unit);
  return from && to && from[0] === to[0] ? Math.round(r.qty * from[1] / to[1] * 1000) / 1000 : r.qty;
}
// The unit a line's shortfall is in: its part's, unless that's pieces or another kind than the line's own.
export function unitOf(r) {
  const pu = r.m?.p.unit;
  if (!pieces(pu) && (!r.unit || (per(r.unit) && per(pu) && per(r.unit)[0] === per(pu)[0]))) return pu;
  return r.unit || '';
}

// What the lines matched to each part need between them, by part id: { qty, lines }, in the part's unit. Two lines for
// one part ("2x M3 heat-set insert" and "M3 heat-set inserts x6") need 8, which 6 in stock doesn't cover, though each
// line alone fits.
export function needs(items) {
  const out = new Map();
  for (const r of items) {
    if (!r.m) continue;
    const n = out.get(r.m.p.id) || { qty: 0, lines: 0 };
    out.set(r.m.p.id, { qty: Math.round((n.qty + inPartUnit(r)) * 1000) / 1000, lines: n.lines + 1 });
  }
  return out;
}
