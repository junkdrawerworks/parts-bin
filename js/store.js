// localStorage is the working copy. The page talks to it through a few calls shaped like the ones the
// Stockroom artifact used (doc(path).set/update/delete, collection(name).onSnapshot), so the screens
// didn't need rewriting. sync.js merges this copy with Google Drive when that's on.
import * as M from './model.js';

export const KEY = 'parts-bin';
const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };

// A copy saved before a rule in model.js's cleanItem (a deleted part kept with all its details) is saved again as it's read.
function load() {
  let text = null, raw = null;
  try { text = localStorage.getItem(KEY); raw = JSON.parse(text); } catch { /* blocked, or not JSON */ }
  const d = M.cleanDoc(raw);
  if (raw?.app === M.APP) { const now = M.canon(d); if (now !== text) try { localStorage.setItem(KEY, now); } catch { /* storage full: cleaned again next time */ } }
  return d;
}
let doc = load();
const subs = { bins: [], parts: [], projects: [] };
const saved = [];
const delivered = [];

// A change this browser can't keep (its storage is full) is refused, and nothing changes: the screens only ever show
// what's really saved, and set(), update() and delete() reject so the page can say so.
const full = e => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
function write(next) {
  try { localStorage.setItem(KEY, M.canon(next)); }
  catch (e) { throw full(e) ? { code: 'quota_exceeded', message: 'This browser’s storage is full, so that wasn’t saved.' } : { code: 'unavailable', message: 'Save failed — try again' }; }
  doc = next;
  notify();
  saved.forEach(f => f());
}
let pending = false;
function notify() {
  if (pending) return; pending = true;
  queueMicrotask(() => { pending = false; deliver(); });
}
// One item's odd time mustn't stop the rest from showing.
const iso = t => { const d = new Date(t); return isNaN(d) ? '' : d.toISOString(); };
function deliver() {
  for (const kind of M.KINDS) {
    const docs = M.live(doc, kind).map(x => { const { t, del, id, ...data } = x; return { id, data: () => ({ ...data, updatedAt: iso(t) }) }; });
    for (const f of subs[kind]) { try { f({ docs, size: docs.length, empty: !docs.length }); } catch (e) { console.error(e); } }
  }
  for (const f of delivered) { try { f(); } catch (e) { console.error(e); } }
}
function split(path) {
  const [kind, id] = String(path).split('/');
  if (!M.KINDS.includes(kind) || !id) throw new TypeError('Not a document path: ' + path);
  return [kind, id];
}

export const db = {
  doc(path) {
    const [kind, id] = split(path);
    return {
      id,
      async get() { const x = doc.items[kind][id]; return { id, exists: !!x && !M.gone(x), data: () => x && !M.gone(x) ? { ...x } : undefined }; },
      async set(data) { const { updatedAt, ...rest } = data || {}; write(M.putItem(doc, kind, id, rest)); },
      async update(data) {
        const old = doc.items[kind][id];
        if (!old || M.gone(old)) throw { code: 'deleted', kind, message: 'That was deleted on another device.' }; // or in another tab
        const { t, updatedAt, ...base } = old; write(M.putItem(doc, kind, id, { ...base, ...data }));
      },
      async delete() { write(M.removeItem(doc, kind, id)); },
    };
  },
  collection(kind) {
    if (!M.KINDS.includes(kind)) throw new TypeError('Not a collection: ' + kind);
    return {
      doc: id => db.doc(kind + '/' + (id || M.newId())),
      onSnapshot(next) { subs[kind].push(next); setTimeout(notify, 0); return () => { subs[kind] = subs[kind].filter(f => f !== next); }; },
    };
  },
};

const body = x => { const { t, del, ...rest } = x; return JSON.stringify(rest); }; // what an item says, without its times
export const store = {
  get doc() { return doc; },
  onSave(f) { saved.push(f); }, // after each change that was kept
  onDelivered(f) { delivered.push(f); }, // after every collection has been told of a change, so a page draws once
  reload() { doc = load(); notify(); },
  backup: () => JSON.stringify({ ...JSON.parse(M.canon(doc)), saved: new Date().toISOString() }, null, 1),
  // Merges a file in item by item, so nothing here is lost. Returns how many items it added or changed, and how many of
  // those were deleted here and come back from the file. Those get a new time: the deletion is still on Drive and on other
  // devices, and with the file's old time the next sync would delete them again. there: the parts the file has as deleted
  // on the device it came from that are still here, unchanged since ({ id, del }), for the page to offer to delete too.
  importText(text) {
    let raw; try { raw = JSON.parse(text); } catch { throw new Error('That file isn’t JSON.'); }
    const incoming = M.fromImport(raw);
    const n = M.KINDS.reduce((s, k) => s + Object.keys(incoming.items[k]).length, 0);
    if (!n) throw new Error('That file doesn’t hold any bins, parts or projects.');
    const merged = M.mergeDocs(doc, incoming, { first: true });
    let changed = 0, back = 0;
    const there = [];
    for (const [id, x] of Object.entries(incoming.items.parts)) {
      const here = Object.hasOwn(doc.items.parts, id) && doc.items.parts[id];
      if (M.gone(x) && here && !M.gone(here) && (here.t || 0) <= x.del) there.push({ id, del: x.del });
    }
    for (const k of M.KINDS) for (const [id, m] of Object.entries(merged.items[k])) {
      const here = doc.items[k][id];
      if (M.gone(here) && !M.gone(m)) { const { del, ...x } = m; merged.items[k][id] = { ...x, t: M.stamp(here) }; back++; }
      // Counted only when it shows: here after the load and not before, or saying something different. A deletion that
      // comes with the file, or a new time on what's here already, changes nothing on screen. (Nothing here is deleted by
      // a load: a first-sync merge never removes anything.)
      else if (!M.gone(m) && (!here || body(m) !== body(here))) changed++;
    }
    write(merged);
    return { changed, back, there };
  },
  // The inventory saved at Parts Bin's old address (junkdrawer.works/parts-bin/), as carry.html hands it over: what isn't
  // here at all is added, and nothing here is written over. Returns how many bins, parts and saved BOMs came over, and
  // null when there was no inventory there.
  addMissing(text) {
    let raw = null; try { raw = JSON.parse(text); } catch { /* nothing readable */ }
    if (raw?.app !== M.APP) return null;
    const old = M.cleanDoc(raw), n = { bins: 0, parts: 0, projects: 0 };
    const next = { ...doc, items: { ...doc.items } };
    for (const k of M.KINDS) for (const [id, x] of Object.entries(old.items[k])) {
      if (Object.hasOwn(doc.items[k], id)) continue;
      next.items[k] = { ...next.items[k], [id]: x };
      if (!M.gone(x)) n[k]++;
    }
    if (M.KINDS.some(k => next.items[k] !== doc.items[k])) write(next);
    return n;
  },
};
