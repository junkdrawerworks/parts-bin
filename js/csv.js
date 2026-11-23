// The inventory as a spreadsheet (Settings › Save as a spreadsheet): one row a part, by bin and bag, every field the part
// sheet has. For a move or an insurance list, a club, or checking by eye; it isn't read back in (the backup file is).
// No page code, so tests run it in Node.
//
// Opened in Excel, it reads as UTF-8 (the byte-order mark at the start), so Ω, µ and ₂ show as typed. A cell a spreadsheet
// would take as a formula (one starting =, +, -, @, a tab or a line break, or their full-width forms) starts with a ' so
// it's shown as text instead, and every cell is in double quotes with its own quotes doubled, so a comma or a line break
// in a note stays in its cell. That's OWASP's advice on CSV injection (owasp.org, "CSV Injection"), except that the ' goes
// only before a cell that needs it, not before every one, so the rest read as typed.

const COLUMNS = [
  ['Bin', (p, b) => b?.code], ['Bin name', (p, b) => b?.name], ['Bag', p => bagOf(p) || ''], ['Name', p => p.name],
  ['Quantity', p => p.qty], ['Unit', p => p.unit || 'pcs'], ['Reorder at', p => p.minQty], ['Category', p => p.category],
  ['Part number', p => p.mpn], ['Keywords', p => list(p.tags)], ['Interface', p => list(p.iface)], ['I2C address', p => p.addr],
  ['Supply voltage', p => p.volts], ['Logic level', p => p.logic], ['Link', p => p.link], ['Reference photo', p => p.img],
  ['To check', p => p.check], ['Notes', p => p.notes], ['Came from', p => p.from], ['Tag written', p => (p.tagWritten ? 'yes' : '')],
  ['Last changed', p => day(p.updatedAt)], ['ID', p => p.id],
];
const list = v => (Array.isArray(v) ? v.join(', ') : v);
function bagOf(p) { const n = Number(p?.bag); return p?.bag !== '' && p?.bag != null && Number.isSafeInteger(n) && n > 0 ? n : 0; }
// The day it was last changed where this device is, as a spreadsheet sorts it: 2026-11-03.
function day(iso) { const d = new Date(iso || ''); if (isNaN(d) || d.getFullYear() < 2000) return ''; const two = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; }

const RISKY = /^[=+\-@\t\r\n＝＋－＠]/;
export function cell(v) {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && RISKY.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

const byText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
// parts: the live parts ({id, ...}); bins: id → bin. Parts in no bin (or a bin that's gone) come last.
export function partsCsv(parts, bins) {
  const binOf = p => (p.binId && bins.get(p.binId)) || null;
  const rows = [...parts].sort((a, c) => {
    const x = binOf(a), y = binOf(c);
    if (!x !== !y) return x ? -1 : 1;
    return (x && y ? byText(x.code || '', y.code || '') : 0) || (bagOf(a) || 1e15) - (bagOf(c) || 1e15) || byText(a.name || '', c.name || '');
  });
  const lines = [COLUMNS.map(([h]) => cell(h)).join(',')];
  for (const p of rows) { const b = binOf(p); lines.push(COLUMNS.map(([, f]) => cell(f(p, b))).join(',')); }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
