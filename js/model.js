// The inventory as one document, and how two copies of it merge. No page code, so tests run it in Node.
//
// { app: 'parts-bin', v: 1, items: { bins: {id: bin}, parts: {id: part}, projects: {id: project} } }
// Every item carries t (when it last changed, ms) and, once deleted, del (when). Deleted items keep their
// details so a deletion on one device reaches the others instead of the item coming back from their copy.
// Merging goes item by item: the newer version wins, and a deletion wins over anything older than it.
export const APP = 'parts-bin';
export const KINDS = ['bins', 'parts', 'projects'];

// Names an object already has ('__proto__', 'constructor') would be read or written as something else, so no id is one.
const idOk = id => typeof id === 'string' && /^[\w.:@+~-]{1,80}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
// A time is ms since 1970, up to the last one a Date can hold; anything else counts as none (0).
const MAX_T = 8.64e15;
const tOk = t => (Number.isFinite(+t) && +t >= 0 && +t <= MAX_T ? Math.floor(+t) : 0);

export const blankDoc = () => ({ app: APP, v: 1, items: { bins: {}, parts: {}, projects: {} } });
export const gone = x => !!(x && x.del && x.del >= (x.t || 0));
// One past the item's own time, so a change wins over what it changed, but never past the last time there is: an item
// stamped there stays there (a tie then goes by the tie rule below), where one past it would read as no time at all.
export const stamp = old => Math.min(MAX_T, Math.max(Date.now(), (old?.t || 0) + 1, (old?.del || 0) + 1));

export function newId() {
  const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b);
  return [...b].map(x => (x % 36).toString(36)).join('') + Date.now().toString(36).slice(-3);
}

// Fields the page reads as lists. A file can hold one as text ("sensor, i2c"): that's split the way the edit form splits
// it, tags lower-cased as the form does, and anything else that isn't a list is dropped, so one part can't break every screen.
const LISTS = { tags: s => s.toLowerCase(), iface: s => s };
export const MAX_LIST = 40; // items in a list (tags, interfaces)
const strings = v => v.filter(s => typeof s === 'string').slice(0, MAX_LIST).map(s => s.slice(0, 80));
// How long a text can be. A saved BOM is a whole pasted parts list (a KiCad export with footprints and datasheet links
// runs past 4,000 characters for one board), and a part's notes can be long too; every other field is short.
export const LONG = { text: 200000, notes: 20000 };

// Keeps what a page or a file handed us to plain JSON fields, and drops anything malformed. Every load runs it, so a
// copy saved before a rule here was added is brought into line as it's read.
export function cleanItem(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === 'id' || typeof k !== 'string' || k.length > 40) continue;
    if (v == null) continue;
    if (Object.hasOwn(LISTS, k)) {
      if (Array.isArray(v)) out[k] = strings(v);
      else if (typeof v === 'string') out[k] = strings(v.split(/[,;/]/).map(s => LISTS[k](s.trim())).filter(Boolean));
    } else if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = v; } // NaN and Infinity would be saved as null
    else if (typeof v === 'string' || typeof v === 'boolean') out[k] = typeof v === 'string' ? v.slice(0, Object.hasOwn(LONG, k) ? LONG[k] : 4000) : v;
    else if (Array.isArray(v)) out[k] = strings(v);
  }
  out.t = tOk(x.t);
  if (tOk(x.del)) out.del = tOk(x.del); else delete out.del;
  return out;
}

export function cleanDoc(raw) {
  const doc = blankDoc();
  if (!raw || typeof raw !== 'object') return doc;
  for (const kind of KINDS) {
    const src = raw.items?.[kind];
    if (!src || typeof src !== 'object') continue;
    for (const [id, x] of Object.entries(src)) {
      const c = idOk(id) && cleanItem(x);
      if (c) doc.items[kind][id] = c;
    }
  }
  return doc;
}

// The same document always prints the same way, so two copies can be compared as text.
export function canon(doc) {
  const sortObj = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? sortObj(o[k]) : o[k]]));
  return JSON.stringify(sortObj({ app: APP, v: 1, items: doc.items }));
}

// Whether x wins over y: the later change. Two devices can stamp the same time (a clock behind the item's own stamp gives
// old t + 1 on both), so a tie is settled the same way everywhere: a deletion wins, as gone() reads a deletion and an
// edit at one time, and then the larger of the two as text. Either way round, every copy ends up with the same one.
const stampOf = x => Math.max(x.t || 0, x.del || 0);
const asText = x => JSON.stringify(Object.keys(x).sort().map(k => [k, x[k]]));
function newer(x, y) {
  if (x === y) return true;
  const a = stampOf(x), b = stampOf(y);
  if (a !== b) return a > b;
  if (gone(x) !== gone(y)) return gone(x);
  return asText(x) >= asText(y);
}

// first: this device's first sync with this copy. Then nothing on either side counts as removed.
export function mergeDocs(local, remote, { first = false } = {}) {
  const out = blankDoc();
  for (const kind of KINDS) {
    const a = local?.items?.[kind] || {}, b = remote?.items?.[kind] || {};
    for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const x = Object.hasOwn(a, id) ? a[id] : undefined, y = Object.hasOwn(b, id) ? b[id] : undefined;
      let m = !x ? y : !y ? x : newer(x, y) ? x : y;
      if (first && x && y && gone(m) && (!gone(x) || !gone(y))) m = gone(x) ? y : x;
      out.items[kind][id] = m;
    }
  }
  return out;
}

export const live = (doc, kind) => Object.entries(doc.items[kind]).filter(([, x]) => !gone(x)).map(([id, x]) => ({ id, ...x }));

const own = (o, id) => (Object.hasOwn(o, id) ? o[id] : undefined);
export function putItem(doc, kind, id, fields) {
  const old = own(doc.items[kind], id);
  const item = cleanItem({ ...fields, t: stamp(old) });
  delete item.del;
  return { ...doc, items: { ...doc.items, [kind]: { ...doc.items[kind], [id]: item } } };
}
export function removeItem(doc, kind, id) {
  const old = own(doc.items[kind], id);
  if (!old || gone(old)) return doc;
  return { ...doc, items: { ...doc.items, [kind]: { ...doc.items[kind], [id]: { ...old, del: stamp(old) } } } };
}

// An export from the Stockroom artifact, or a parts-bin backup: either way, one document.
export function fromImport(raw) {
  if (raw?.app === APP) return cleanDoc(raw);
  const doc = blankDoc();
  if (!raw || typeof raw !== 'object') return doc;
  for (const kind of KINDS) {
    const list = Array.isArray(raw[kind]) ? raw[kind] : [];
    for (const x of list) {
      const id = String(x?.id || '');
      if (!idOk(id)) continue;
      const t = Date.parse(x.updatedAt) || 1;
      const c = cleanItem({ ...x, t });
      if (c) doc.items[kind][id] = c;
    }
  }
  return doc;
}
