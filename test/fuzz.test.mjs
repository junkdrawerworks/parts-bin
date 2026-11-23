// Many devices editing, deleting and syncing at random, with clocks set wrong, checked against the merge rules.  node --test
// Every copy must end up the same however the merges were ordered, and the newest change to an item always wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import * as IN from '../js/inbox.js';

// store.js keeps its copy in localStorage: here, a stand-in of its own
const mem = {};
globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const { store, KEY } = await import('../js/store.js');

function rng(seed) { // mulberry32: the same seed gives the same run
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const IDS = ['a', 'b', 'c', 'd', 'e'];
const stampOf = x => Math.max(x?.t || 0, x?.del || 0);
const odd = [NaN, Infinity, -Infinity, 'sensor, i2c', 'I2C', ['x', 3], { y: 1 }, '', 0, -2.5];

test('merging in any order, with clocks set wrong and edits stamped the same, ends with every copy the same', () => {
  const realNow = Date.now;
  let merges = 0, ties = 0;
  // M.canon's order and content, faster: items are flat, so sorting their keys is enough
  // (a copy is never changed in place, so each item's text is worked out once)
  const memo = new WeakMap(), flat = x => memo.get(x) ?? memo.set(x, JSON.stringify(Object.keys(x).sort().map(k => [k, x[k]]))).get(x);
  const C = d => JSON.stringify(M.KINDS.map(k => Object.keys(d.items[k]).sort().map(id => [id, flat(d.items[k][id])])));
  const check = (a, b, c) => {
    const ab = M.mergeDocs(a, b), cab = C(ab), ca = C(a);
    merges++;
    assert.equal(cab, C(M.mergeDocs(b, a)), 'the same either way round');
    assert.equal(C(M.mergeDocs(ab, c)), C(M.mergeDocs(a, M.mergeDocs(b, c))), 'the same however they’re grouped');
    assert.equal(C(M.mergeDocs(a, a)), ca, 'merging a copy with itself changes nothing');
    const first = M.mergeDocs(a, b, { first: true });
    assert.equal(C(first), C(M.mergeDocs(b, a, { first: true })), 'a first sync is the same either way round');
    for (const kind of M.KINDS) for (const d of [a, b]) for (const [id, x] of Object.entries(d.items[kind])) if (!M.gone(x)) assert.ok(!M.gone(first.items[kind][id]), 'a first sync drops nothing that’s here');
    for (const kind of M.KINDS) for (const id of Object.keys(ab.items[kind])) {
      const x = a.items[kind][id], y = b.items[kind][id];
      if (x && y && stampOf(x) === stampOf(y) && JSON.stringify(x) !== JSON.stringify(y)) ties++;
      assert.equal(stampOf(ab.items[kind][id]), Math.max(stampOf(x), stampOf(y)), 'the newest change wins');
    }
    const saved = M.canon(ab);
    assert.equal(M.canon(M.cleanDoc(JSON.parse(saved))), saved, 'what’s saved reads back the same');
  };
  try {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
      const n = 2 + Math.floor(r() * 3), tie = seed % 3 === 0;
      // in tie mode every clock is stopped behind the stamps, so each edit is the item's own t + 1, the same on two devices
      const skew = Array.from({ length: n }, () => (tie ? 0 : Math.floor((r() - 0.5) * 20 * 60000)));
      let now = 1.8e12, drive = M.blankDoc();
      const docs = Array.from({ length: n }, () => M.blankDoc());
      for (let step = 0; step < 100; step++) {
        const d = Math.floor(r() * n), op = r();
        if (!tie) now += Math.floor(r() * 3);
        Date.now = () => now + skew[d];
        const kind = r() < 0.8 ? 'parts' : pick(M.KINDS), id = pick(IDS);
        if (op < 0.4) {
          const fields = { name: pick(['BME280', 'SCD41', 'SGP30']), qty: Math.floor(r() * 6) };
          if (r() < 0.3) fields[pick(['tags', 'iface', 'qty', 'minQty', 'notes'])] = pick(odd);
          docs[d] = M.putItem(docs[d], kind, id, fields);
        } else if (op < 0.55) docs[d] = M.removeItem(docs[d], kind, id);
        else if (op < 0.8) drive = docs[d] = M.mergeDocs(docs[d], drive); // a sync: both end up with the merge
        else { const e = Math.floor(r() * n); docs[d] = M.mergeDocs(docs[d], docs[e]); }
        const all = [...docs, drive];
        check(pick(all), pick(all), pick(all));
      }
      // everyone syncs twice: every copy is the same, and the second round writes nothing new
      for (let i = 0; i < n; i++) drive = docs[i] = M.mergeDocs(docs[i], drive);
      const settled = C(drive);
      for (let i = 0; i < n; i++) drive = docs[i] = M.mergeDocs(docs[i], drive);
      assert.equal(C(drive), settled, `seed ${seed}: Drive is still changing`);
      for (const x of docs) assert.equal(C(x), settled, `seed ${seed}: a device ended up different`);
      // a backup loaded back into the copy it came from changes nothing, and says so
      if (seed % 4 === 0) {
        mem[KEY] = M.canon(drive); store.reload();
        assert.deepEqual(store.importText(store.backup()), { changed: 0, back: 0, there: [] }, `seed ${seed}: loading its own backup changed something`);
        assert.equal(M.canon(store.doc), M.canon(drive), `seed ${seed}: loading its own backup changed the copy`);
      }
    }
  } finally { Date.now = realNow; }
  assert.ok(ties > 50, `ties were tried (${ties} in ${merges} merges)`);
});

test('random batches from Claude never break the Inbox, keep only what it knows, and clean the same twice', () => {
  const r = rng(7), pick = a => a[Math.floor(r() * a.length)];
  const words = ['BME280', ' ', '  ', 'i2c', 'SPI', 'qwiic', 'x'.repeat(130), 'https://exa mple.com/a b', 'javascript:alert(1)', 'https://192.168.1.1/x', 'https://adafruit.com/p/1',
    'Ω', 'µF', '__proto__', 'constructor', ',', ';', '/', '\n', '\t', 'İ', '0x76', '3.3 V'];
  const text = () => Array.from({ length: Math.floor(r() * 8) }, () => pick(words)).join(pick(['', ' ', '  ']));
  const value = () => { const v = r(); return v < 0.5 ? text() : v < 0.6 ? Math.floor((r() - 0.3) * 2e6) : v < 0.7 ? [text(), text(), 5] : v < 0.75 ? { a: 1 } : v < 0.8 ? null : v < 0.85 ? true : String(Math.floor(r() * 50)); };
  const KNOWN = new Set([...IN.FIELDS, 'id', 'match', 'qty', 'add', 'unit', 'k']);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) {
    const items = Array.from({ length: Math.floor(r() * 6) }, () => {
      const x = {}; for (const k of [...IN.FIELDS, 'id', 'match', 'qty', 'add', 'unit', 'unsure', 'onclick']) if (r() < 0.4) x[k] = k === 'id' || k === 'match' ? pick(['p-1', 'bad id', '__proto__', 'x'.repeat(90)]) : value();
      return r() < 0.05 ? pick([null, 'junk', [1]]) : x;
    });
    const raw = r() < 0.03 ? pick([null, {}, { partsbin: 1 }, { partsbin: 1, batch: { items: 'no' } }]) : { partsbin: 1, batch: { id: pick([undefined, 'b1', '__proto__', 'a b']), name: value(), source: pick(['photo', 'details', 'nope']), bin: value(), items } };
    const once = IN.cleanBatch(raw);
    if (!once) continue;
    assert.deepEqual(IN.cleanBatch({ partsbin: 1, batch: once }), once, 'cleaned twice, the same');
    assert.ok(!['__proto__', 'constructor', 'prototype'].includes(once.id));
    for (const x of once.items) {
      for (const k of Object.keys(x)) assert.ok(KNOWN.has(k), 'an unknown field: ' + k);
      for (const k of ['link', 'img']) if (x[k]) assert.match(x[k], /^https:\/\/[^/]*\.[a-z]{2,}\//i, k);
      for (const [k, v] of Object.entries(x)) if (typeof v === 'string') assert.equal(v, v.trim(), k + ' ends in a space');
    }
  }
  assert.ok(performance.now() - t0 < 3000, 'quick');
});
