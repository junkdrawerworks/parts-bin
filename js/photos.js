// Your own photos of parts: a small picture cut from a photo identified in Pack, or one chosen on a part's page, shown
// where a reference photo would be when the part has none. Kept in this browser only (IndexedDB), never in the inventory
// itself, so not in Drive or a backup file: at about 10 KB each, 1,500 of them would fill this browser's localStorage, and
// Drive's one file goes up whole with every change.
const DB = 'parts-bin.photos', STORE = 'photos';
export const SIDE = 256; // the long side, in pixels: sharp in a part page's box on a phone, about 10 KB as a JPEG
const ids = new Set();
let opened = null, loaded = null;

function open() {
  opened ||= new Promise((res, rej) => {
    let r; try { r = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
  });
  return opened;
}
function run(mode, f) {
  return open().then(db => new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode), r = f(tx.objectStore(STORE));
    tx.oncomplete = () => res(r.result); tx.onerror = tx.onabort = () => rej(tx.error);
  }));
}

export const photos = {
  // Which parts have one, read once at start, so a page can tell without waiting. A browser with no IndexedDB (a private
  // window in some) has none, and keeping one says so.
  load() { loaded ||= run('readonly', s => s.getAllKeys()).then(keys => { for (const k of keys || []) ids.add(k); }).catch(() => {}); return loaded; },
  has: id => ids.has(id),
  get: id => (ids.has(id) ? run('readonly', s => s.get(id)).then(v => v?.src || null).catch(() => null) : Promise.resolve(null)),
  async put(id, src) { await run('readwrite', s => s.put({ src, t: Date.now() }, id)); ids.add(id); },
  async remove(id) { await run('readwrite', s => s.delete(id)); ids.delete(id); },
  // Photos of parts that are gone for good (see app.js), so the store doesn't keep growing
  async prune(keep) { for (const id of [...ids]) if (!keep(id)) await photos.remove(id).catch(() => {}); },
};

// A box Claude gave round one part, [left, top, right, bottom] as fractions of the picture: inside it, and big enough to
// be a part. Anything else is no box.
export function okBox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const v = b.map(Number); if (v.some(x => !Number.isFinite(x))) return null;
  const [l, t, r, bt] = v.map(x => Math.min(1, Math.max(0, x)));
  return r - l >= 0.02 && bt - t >= 0.02 ? [l, t, r, bt] : null;
}

// The picture as a small JPEG (a data: URL): the part inside box, with a margin round it, or the whole picture when there's
// no box to cut to (a photo chosen for that one part). null when a box was asked for and isn't one: then there's no
// picture, rather than the whole bench.
export async function thumb(file, box = null, whole = false) {
  const b = okBox(box); if (!b && !whole) return null;
  const bmp = await createImageBitmap(file), W = bmp.width, H = bmp.height;
  let sx = 0, sy = 0, sw = W, sh = H;
  if (b) {
    const padX = Math.max((b[2] - b[0]) * 0.12, 0.02), padY = Math.max((b[3] - b[1]) * 0.12, 0.02);
    const l = Math.max(0, b[0] - padX), t = Math.max(0, b[1] - padY), r = Math.min(1, b[2] + padX), bt = Math.min(1, b[3] + padY);
    sx = l * W; sy = t * H; sw = (r - l) * W; sh = (bt - t) * H;
  }
  const k = Math.min(1, SIDE / Math.max(sw, sh)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.8);
}
