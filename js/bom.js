// BOM check: reading a pasted parts list, and finding each line in the inventory. Search uses norm() too.
// No page code, so tests run it in Node.

// Lower case, with anything but letters, digits, dots and plus signs read as a space: "ESP32-S3" is "esp32 s3".
export const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9.+]+/g, ' ').trim();

// One part per line (or per ;), with its count first or last: "2x XIAO ESP32-S3", "SCD41 ×1". Lines starting with # are
// skipped, and a bullet in front is dropped. A name can start with a digit (1N4148, 74HC595, 18650 cells), so each way of
// writing a count says which side the count is on, and a marked count (2x, x8, ×2, ", 5") is believed before a bare
// number at the start: "18650 cells×2" is two 18650 cells. A size isn't a count: a pin header's 1x40 and a screw's M3x8
// are part of the name. Nor is a long number before a single word, with no other count: "555 timer" is one 555.
const N = '(\\d+(?:\\.\\d+)?)';
const SIZE = /(^|\s)M?\d+(\.\d+)?$/i; // what comes before the x of a size: a bare number (1x40) or an M size (M2.5x6)
const COUNTS = [ // [pattern, the count's group, the name's group, unless(match) it's not a count after all]
  [new RegExp(`^${N}\\s*[x×*]\\s+(.+)$`, 'i'), 1, 2], // 2x name, 2 x name
  [new RegExp(`^(.+?)\\s+[x×*]\\s*${N}$`, 'i'), 2, 1], // name x8, name × 2
  [new RegExp(`^(.+?)\\s*[,\\t]\\s*${N}$`), 2, 1], // name, 5 (or a tab, from a spreadsheet)
  // name×2, SCD41x2; not a size, and not a word that ends in x (Box2)
  [new RegExp(`^(.+?)(?:[×*]|(?<![a-z])x)\\s*${N}$`, 'i'), 2, 1, m => SIZE.test(m[1])],
  [new RegExp(`^${N}\\s+(.+)$`), 1, 2, m => /^\d{3,}$/.test(m[1]) && !/\s/.test(m[2])], // 3 name; not 555 timer
];
export function parseBom(text) {
  return String(text || '').split(/\n|;/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/^[-•*]\s*/, '')).filter(Boolean).map(l => {
    for (const [re, q, n, unless] of COUNTS) { const m = re.exec(l); if (m && !unless?.(m)) return { qty: Number(m[q]), name: m[n].trim() }; }
    return { qty: 1, name: l };
  });
}

// A part number is a word with letters and digits, four characters or more: SCD41, 1N4148, ESP32, 3.3V. A number with a
// unit isn't one (100uF, 40pin, 1000mAh, 2.54mm): those are written so many ways ("40pin", "40 pin") that they can't rule a
// part out. A voltage is one, though, since a 3.3V regulator isn't a 5V one. Takes a word from norm().
const UNIT = /^\d+(\.\d+)?[a-z]+$/, VOLTS = /^\d+(\.\d+)?v$/;
export const isPartNumber = w => w.length >= 4 && /[a-z]/.test(w) && /\d/.test(w) && (!UNIT.test(w) || VOLTS.test(w));

// A value or a variant: a number with a unit (1k, 4.7k, 100uF, 3mm) or a short code with a digit (C3, S3, M3). A part
// without one the line has may still be the part, but isn't sure to be (a 10k resistor for "1k resistor", an ESP32-S3
// for "ESP32-C3"), so it matches no better than fuzzy. "100 uF" and "100uF" are the same value. Takes words from norm().
const isValue = w => UNIT.test(w) || (w.length <= 3 && /\d/.test(w) && /[a-z]/.test(w));
const joined = hay => hay.replace(/(^| )(\d+(?:\.\d+)?) ([a-z]+)(?= |$)/g, '$1$2$3'); // "100 uf" as "100uf"
const FUZZY = 0.75; // under BOM check's 0.8 for a sure match

// The part a line most likely means: the one whose name, part number and tags hold the most of the line's words, counted
// by length, with part numbers counted twice. A line that names a part number only matches a part that has one of them,
// and a part that has one always matches, at a share of at least 0.6: "SCD41 breakout" is the SCD41, and "BME280
// breakout" isn't a BMP280 breakout. A line of plain words needs at least half of them. conf is the share, at most
// FUZZY for a part without one of the line's values or variants.
export function matchPart(name, parts) {
  const t = norm(name).split(' ').filter(w => w.length > 1); if (!t.length) return null;
  const weight = w => (isPartNumber(w) ? 2 : 1) * w.length, all = t.reduce((n, w) => n + weight(w), 0);
  const numbered = t.some(isPartNumber), values = t.filter(isValue);
  let best = null, bs = 0;
  for (const p of parts) {
    const hay = norm([p.name, p.mpn, (p.tags || []).join(' ')].join(' ')), hayJ = joined(hay);
    let s = 0, shared = false;
    for (const w of t) if (hay.includes(w) || hayJ.includes(w)) { s += weight(w); if (isPartNumber(w)) shared = true; }
    let cov = s / all;
    if (numbered ? !shared : cov < 0.5) continue;
    if (values.length) { const has = new Set([...hay.split(' '), ...hayJ.split(' ')]); if (values.some(w => !has.has(w))) cov = Math.min(cov, FUZZY); }
    if (cov > bs) { bs = cov; best = p; }
  }
  return best ? { p: best, conf: numbered ? Math.max(bs, 0.6) : bs } : null;
}

// How many more a line needs than there are, to the thousandth: 0.3 m wanted with 0.1 m in stock is short 0.2 (plain
// subtraction says 0.19999999999999998).
export const shortBy = (need, have) => Math.round((need - have) * 1000) / 1000;
