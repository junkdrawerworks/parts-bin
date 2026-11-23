// The inventory as a spreadsheet: by bin and bag, every field, safe to open in Excel.  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { partsCsv, cell } from '../js/csv.js';

// A plain reader for what partsCsv writes: quoted cells, doubled quotes, CRLF between rows (and inside none).
function read(text) {
  assert.equal(text[0], '﻿', 'starts with the byte-order mark, so Excel reads it as UTF-8');
  const rows = []; let row = [], s = '', q = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { s += '"'; i++; } else if (c === '"') q = false; else s += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(s); s = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(s); rows.push(row); row = []; s = ''; i++; }
    else throw new Error('unquoted text at ' + i);
  }
  return rows;
}

const bins = new Map([['b2', { code: 'B10', name: 'Power' }], ['b1', { code: 'B2', name: 'Sensors' }], ['x', { code: 'BOX 01', kind: 'box', name: 'Bench' }]]);
const parts = [
  { id: 'p1', name: 'Zener', binId: 'b2', qty: 20, unit: 'pcs', bag: 4 },
  { id: 'p2', name: 'BME280', binId: 'b1', qty: 3, unit: 'pcs', bag: 12, tags: ['i2c', 'qwiic'], iface: ['I2C', 'SPI'], addr: '0x76', updatedAt: '2026-11-03T10:00:00.000Z', tagWritten: true },
  { id: 'p3', name: 'Loose', qty: 1 },
  { id: 'p4', name: 'Buck', binId: 'b2', qty: 2, bag: 2 },
  { id: 'p5', name: 'Gone bin', binId: 'nope', qty: 1 },
  { id: 'p6', name: 'Spare', binId: 'b2', qty: 1 },
  { id: 'p7', name: 'Packed', binId: 'x', qty: 1, bag: 1, from: 'B2' },
];

test('one row a part, by bin code (B2 before B10), then bag number, then name; no bin last', () => {
  const rows = read(partsCsv(parts, bins));
  assert.deepEqual(rows[0].slice(0, 7), ['Bin', 'Bin name', 'Bag', 'Name', 'Quantity', 'Unit', 'Reorder at']);
  assert.ok(rows.every(r => r.length === rows[0].length), 'every row has every column');
  assert.deepEqual(rows.slice(1).map(r => r[3]), ['BME280', 'Buck', 'Zener', 'Spare', 'Packed', 'Gone bin', 'Loose']);
  const h = rows[0], bme = Object.fromEntries(h.map((k, i) => [k, rows[1][i]]));
  assert.equal(bme.Bin, 'B2'); assert.equal(bme['Bin name'], 'Sensors'); assert.equal(bme.Bag, '12'); assert.equal(bme.Quantity, '3');
  assert.equal(bme.Keywords, 'i2c, qwiic'); assert.equal(bme.Interface, 'I2C, SPI'); assert.equal(bme['I2C address'], '0x76');
  assert.equal(bme['Tag written'], 'yes'); assert.match(bme['Last changed'], /^2026-11-0[34]$/); assert.equal(bme.ID, 'p2');
  assert.equal(rows.find(r => r[3] === 'Packed')[h.indexOf('Came from')], 'B2');
  assert.equal(rows.find(r => r[3] === 'Loose')[h.indexOf('Unit')], 'pcs');
});

test('what a spreadsheet would run as a formula is shown as text; quotes, commas, line breaks and Ω stay in their cell', () => {
  for (const bad of ['=HYPERLINK("http://x","y")', '+1+2', '-2+3', '@SUM(A1)', '\tx', '\rx', '\nx', '＝1+1']) assert.equal(cell(bad), '"\'' + bad.replace(/"/g, '""') + '"', JSON.stringify(bad));
  assert.equal(cell('4.7kΩ, 1%'), '"4.7kΩ, 1%"'); assert.equal(cell('CO₂ "sensor"'), '"CO₂ ""sensor"""'); assert.equal(cell(5), '"5"'); assert.equal(cell(undefined), '""');
  const rows = read(partsCsv([{ id: 'q', name: '=cmd|\' /C calc\'!A0', notes: 'line one\r\nline two, "quoted"', volts: '-5 V', qty: 0 }], new Map()));
  const h = rows[0], r = rows[1];
  assert.equal(rows.length, 2, 'a note with a line break is still one row');
  assert.equal(r[h.indexOf('Name')], '\'=cmd|\' /C calc\'!A0');
  assert.equal(r[h.indexOf('Notes')], 'line one\r\nline two, "quoted"');
  assert.equal(r[h.indexOf('Supply voltage')], '\'-5 V'); assert.equal(r[h.indexOf('Quantity')], '0');
});
