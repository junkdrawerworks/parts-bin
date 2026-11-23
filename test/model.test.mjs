import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const doc = (parts) => ({ app: M.APP, v: 1, items: { bins: {}, parts, projects: {} } });

test('newer edit wins, item by item', () => {
  const a = doc({ x: { name: 'BME280', qty: 5, t: 10 }, y: { name: 'SCD41', qty: 3, t: 50 } });
  const b = doc({ x: { name: 'BME280', qty: 4, t: 20 }, y: { name: 'SCD41', qty: 1, t: 40 } });
  const m = M.mergeDocs(a, b);
  assert.equal(m.items.parts.x.qty, 4);
  assert.equal(m.items.parts.y.qty, 3);
});
test('a deletion reaches the other copy, unless it is the first sync', () => {
  const a = doc({ x: { name: 'BME280', t: 10, del: 30 } });
  const b = doc({ x: { name: 'BME280', t: 20 } });
  assert.ok(M.gone(M.mergeDocs(a, b).items.parts.x));
  assert.ok(!M.gone(M.mergeDocs(a, b, { first: true }).items.parts.x));
});
test('an edit after a deletion brings it back', () => {
  const a = doc({ x: { name: 'BME280', t: 10, del: 30 } });
  const b = doc({ x: { name: 'BME280', t: 40, qty: 2 } });
  assert.ok(!M.gone(M.mergeDocs(a, b).items.parts.x));
});
test('merging is the same either way round', () => {
  const a = doc({ x: { name: 'A', t: 10 }, y: { name: 'B', t: 5, del: 7 } });
  const b = doc({ x: { name: 'A2', t: 12 }, z: { name: 'C', t: 3 } });
  assert.equal(M.canon(M.mergeDocs(a, b)), M.canon(M.mergeDocs(b, a)));
});
test('reads a Stockroom artifact export', () => {
  const d = M.fromImport({ bins: [{ id: 'bin-env', code: 'ENV', name: 'Environmental', updatedAt: '2026-09-30T13:30:00Z' }],
    parts: [{ id: 'p-scd41', name: 'SCD41', qty: 3, binId: 'bin-env', tags: ['generic'], updatedAt: '2026-09-30T13:30:00Z' }, { id: '../bad', name: 'x' }], projects: [] });
  assert.equal(d.items.bins['bin-env'].code, 'ENV');
  assert.equal(d.items.parts['p-scd41'].qty, 3);
  assert.deepEqual(d.items.parts['p-scd41'].tags, ['generic']);
  assert.equal(Object.keys(d.items.parts).length, 1);
});
test('putItem and removeItem stamp times that move forward', () => {
  let d = M.blankDoc();
  d = M.putItem(d, 'parts', 'a', { name: 'X' });
  const t1 = d.items.parts.a.t;
  d = M.removeItem(d, 'parts', 'a');
  assert.ok(d.items.parts.a.del > t1 - 1 && M.gone(d.items.parts.a));
  d = M.putItem(d, 'parts', 'a', { name: 'X' });
  assert.ok(!M.gone(d.items.parts.a));
});
test('a change time no date can hold is read as none, so one bad item can’t hide the rest', () => {
  const d = M.cleanDoc({ items: { parts: { zz: { name: 'From the file', qty: 1, t: 9e15 }, far: { name: 'Far but real', t: 8.64e15 }, ok: { name: 'BME280', t: 10 } } } });
  assert.equal(d.items.parts.zz.t, 0);
  assert.equal(d.items.parts.far.t, 8.64e15);
  assert.equal(d.items.parts.ok.t, 10);
  for (const x of M.live(d, 'parts')) assert.doesNotThrow(() => new Date(x.t).toISOString(), x.name);
});
test('a copy saved with tags or an interface as text loads them as lists, and odd numbers are dropped', () => {
  // an old document: a Stockroom or hand-made file loaded before this rule, with "tags": "sensor, i2c"
  const old = { app: 'parts-bin', v: 1, items: { bins: {}, projects: {}, parts: {
    a: { name: 'BME280', tags: 'Sensor, I2C; qwiic/ ', iface: 'I2C', qty: 5, t: 10 },
    b: { name: 'SCD41', tags: ['generic'], iface: ['I2C'], t: 10 },
    c: { name: 'Odd', tags: { x: 1 }, iface: 7, qty: NaN, minQty: Infinity, bag: -Infinity, t: 10 },
  } } };
  for (const d of [M.cleanDoc(old), M.fromImport(old), M.fromImport({ parts: [{ id: 'a', name: 'BME280', tags: 'Sensor, I2C; qwiic/ ', iface: 'I2C' }] })]) {
    assert.deepEqual(d.items.parts.a.tags, ['sensor', 'i2c', 'qwiic']);
    assert.deepEqual(d.items.parts.a.iface, ['I2C']);
  }
  const d = M.cleanDoc(old);
  assert.deepEqual(d.items.parts.b.tags, ['generic'], 'a list stays as it is');
  assert.deepEqual(Object.keys(d.items.parts.c).sort(), ['name', 't']);
  assert.equal(d.items.parts.a.qty, 5);
  // what's saved reads back the same
  const back = M.cleanDoc(JSON.parse(M.canon(d)));
  assert.equal(M.canon(back), M.canon(d));
});
test('ids an object already has are refused, so they can’t vanish or turn into something else', () => {
  const raw = JSON.parse('{"app":"parts-bin","items":{"parts":{"__proto__":{"name":"P","t":1},"constructor":{"name":"C","t":1},"prototype":{"name":"Q","t":1},"ok":{"name":"BME280","t":1}}}}');
  for (const d of [M.cleanDoc(raw), M.fromImport({ parts: [{ id: '__proto__', name: 'P' }, { id: 'constructor', name: 'C' }, { id: 'ok', name: 'BME280' }] })]) {
    assert.deepEqual(Object.keys(d.items.parts), ['ok']);
    assert.equal(Object.getPrototypeOf(d.items.parts), Object.prototype);
  }
  // nothing a doc hasn't got is read off Object itself
  assert.deepEqual(M.removeItem(M.blankDoc(), 'parts', 'constructor').items.parts, {});
  assert.equal(M.putItem(M.blankDoc(), 'parts', 'toString', { name: 'X' }).items.parts.toString.t > 0, true);
  const m = M.mergeDocs(M.putItem(M.blankDoc(), 'parts', 'constructor', { name: 'X' }), M.blankDoc());
  assert.equal(m.items.parts.constructor.name, 'X');
});
test('two changes stamped the same time come out the same on every device', () => {
  // a phone whose clock runs fast stamped the item; the laptop and the tablet are behind it, so both stamp its t + 1
  const laptop = doc({ x: { name: 'SCD41', qty: 4, t: 1800000600001 } }), tablet = doc({ x: { name: 'SCD41', qty: 2, t: 1800000600001 } });
  assert.equal(M.canon(M.mergeDocs(laptop, tablet)), M.canon(M.mergeDocs(tablet, laptop)));
  // one deletes it and the other edits it at the same time: the deletion wins, either way round
  const del = doc({ x: { name: 'SCD41', qty: 3, t: 50, del: 70 } }), edit = doc({ x: { name: 'SCD41', qty: 5, t: 70 } });
  assert.ok(M.gone(M.mergeDocs(del, edit).items.parts.x)); assert.ok(M.gone(M.mergeDocs(edit, del).items.parts.x));
  // a later edit still wins over both
  assert.equal(M.mergeDocs(doc({ x: { name: 'SCD41', qty: 9, t: 71 } }), M.mergeDocs(del, edit)).items.parts.x.qty, 9);
});
test('a part deleted here and loaded back from a backup stays, even after a sync with the old deletion', async () => {
  const mem = {};
  globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const { store, db } = await import('../js/store.js');
  await db.doc('parts/p-scd41').set({ name: 'SCD41', qty: 3 });
  await db.doc('parts/p-bme280').set({ name: 'BME280', qty: 5 });
  const backup = store.backup();
  await new Promise(r => setTimeout(r, 2));
  await db.doc('parts/p-scd41').delete();
  const tombstone = store.doc; // what Drive and the other devices now hold
  await db.doc('parts/p-bme280').update({ qty: 6 });
  assert.deepEqual(store.importText(backup), { changed: 0, back: 1 }, 'the BME280 here is newer than the file’s, so only the SCD41 changes');
  const back = store.doc.items.parts['p-scd41'];
  assert.ok(!M.gone(back) && !('del' in back) && back.t > tombstone.items.parts['p-scd41'].del);
  assert.equal(store.doc.items.parts['p-bme280'].qty, 6);
  // the next ordinary sync, with Drive still holding the deletion, keeps it, either way round
  assert.ok(!M.gone(M.mergeDocs(store.doc, tombstone).items.parts['p-scd41']));
  assert.ok(!M.gone(M.mergeDocs(tombstone, store.doc).items.parts['p-scd41']));
  assert.deepEqual(store.importText(backup), { changed: 0, back: 0 }, 'loading it again changes nothing');
});
test('a long saved BOM and long notes keep every character, through saving, loading and merging', () => {
  const text = Array.from({ length: 150 }, (_, i) => `"R${i}","10k","Resistor_SMD:R_0603_1608Metric","https://example.com/ds/${i}"`).join("\n").slice(0, 6000);
  assert.equal(text.length, 6000);
  let d = M.putItem(M.blankDoc(), 'projects', 'pr', { name: 'Badge + ESPKey', text });
  d = M.putItem(d, 'parts', 'p', { name: 'Pinecil', notes: 'n'.repeat(6000) });
  assert.equal(d.items.projects.pr.text, text);
  const loaded = M.cleanDoc(JSON.parse(M.canon(d)));
  assert.equal(loaded.items.projects.pr.text, text);
  assert.equal(loaded.items.parts.p.notes.length, 6000);
  const m = M.mergeDocs(M.blankDoc(), loaded);
  assert.equal(m.items.projects.pr.text, text);
  assert.equal(M.cleanDoc(JSON.parse(M.canon(M.mergeDocs(loaded, m)))).items.projects.pr.text, text);
  // every other field keeps its limit, and the long ones have theirs
  const c = M.cleanItem({ name: 'n'.repeat(5000), text: 't'.repeat(300000), notes: 'o'.repeat(30000), t: 1 });
  assert.deepEqual([c.name.length, c.text.length, c.notes.length], [4000, 200000, 20000]);
});
test('an old document with short fields loads exactly as it was saved', () => {
  const old = { app: M.APP, v: 1, items: {
    bins: { b: { code: 'ENV', name: 'Environmental', location: 'Workroom', t: 5 } },
    parts: { p: { name: 'SCD41', qty: 3, unit: 'pcs', binId: 'b', tags: ['generic'], notes: 'on the shelf', bag: 2, tagWritten: true, t: 7 }, q: { name: 'Gone', t: 3, del: 9 } },
    projects: { pr: { name: 'Test BOM', text: '2 BME280\n1 SCD41', t: 8 } } } };
  assert.equal(M.canon(M.cleanDoc(JSON.parse(JSON.stringify(old)))), M.canon(old));
});
