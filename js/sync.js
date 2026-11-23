// Saving to Google Drive, so the inventory follows a person from device to device.
// The page keeps working from localStorage exactly as before. When someone turns this on, the inventory goes
// into one small file in a "Parts Bin" folder in their own Google Drive, and what their other
// devices saved there is merged back in, item by item (model.js).
// Nothing about this shows away from parts-bin.junkdrawer.works.
import { cleanDoc, canon, mergeDocs, APP } from './model.js';
import { KEY } from './store.js';
import { KEY as INBOX } from './inbox.js';

// The junkdrawer.works OAuth client, shared by every junkdrawer.works project. Google only accepts it
// from the addresses it lists, so anywhere else (localhost, the single-file copy) nothing about Drive shows.
// Parts Bin lives at its own address now; it used to be at junkdrawer.works/parts-bin/, which forwards here.
const ORIGINS = ['https://parts-bin.junkdrawer.works', 'https://junkdrawer.works'];
const CLIENT_ID = ORIGINS.includes(location.origin) ? '897653851078-p5jrh2bto6h3bj0lc4jist3k1vsc1pj4.apps.googleusercontent.com' : '';
// drive.file, like every junkdrawer.works project: Google lets them see only the files they made.
// Ours are one folder and one file in it, found by their appProperties, never by name.
const SCOPE = 'https://www.googleapis.com/auth/drive.file', API = 'https://www.googleapis.com/';
const FOLDER = { name: 'Parts Bin', mimeType: 'application/vnd.google-apps.folder', appProperties: { partsbin: 'folder' } };
const FILE = { name: 'Parts Bin.json', mimeType: 'application/json', appProperties: { partsbin: 'sync' } };
// KT is shared by every junkdrawer.works project: one sign-in, good for an hour, serves them all.
const KS = 'parts-bin.sync', KT = 'junkdrawer.google';
const RETRY = { retry: true }, FULL = { full: true };
const OFFLINE = 'Offline. Changes are kept on this device and go to Drive when you’re back online.';

const get = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const readLocal = () => cleanDoc(get(KEY));
const fresh = () => ({ on: false, email: '', name: '', last: 0, fileId: '' });

let st = { ...fresh(), ...(get(KS) || {}) }, tok = get(KT);
let status = 'off', note = '', busy = null, again = false, client = null, gisLoading = false, pushT = null;
const ups = [], watchers = [];

const saveSt = () => put(KS, st);
const good = t => !!(t && t.token && t.exp - 60000 > Date.now() && String(t.scope || '').includes(SCOPE));
// A sign-in with more than a minute left: this page's, or a newer one another junkdrawer.works project saved.
const live = () => good(tok) || (good(get(KT)) && !!(tok = get(KT)));
function setStatus(s, n = '') { status = s; note = n; for (const f of [...watchers]) { try { if (f() === false) watchers.splice(watchers.indexOf(f), 1); } catch { watchers.splice(watchers.indexOf(f), 1); } } }
// Signed out: what went wrong at the last sign-in still says so until the next one.
const signedOut = () => setStatus('tap', status === 'tap' ? note : '');

// A request that never answers (a stalled connection: one bar in the garage, a café's Wi-Fi sign-in page) is given up
// after 30 seconds without a byte and counts as Drive not reached, so the sync ends and the next one can start. A slow
// connection that's still getting somewhere isn't a stalled one: sending is given time for the file to go up at 8 KB a
// second as well, and while the file comes down each piece that arrives starts the 30 seconds again, so a long inventory
// on one bar still syncs. (The tests shorten the wait.)
const WAIT = () => +window.__driveTimeout || 30000;
async function api(method, path, body, type, as = null) { // as: a sign-in not taken on yet (whoami's)
  const t = as || tok;
  if (!t) throw { auth: true };
  const headers = { Authorization: 'Bearer ' + t.token };
  if (type) headers['Content-Type'] = type;
  const stop = new AbortController();
  let timer;
  const wait = (extra = 0) => { clearTimeout(timer); timer = setTimeout(() => stop.abort(), WAIT() + extra); };
  wait(body ? Math.ceil(body.length / 8) : 0);
  try {
    const r = await fetch(API + path, { method, headers, body, signal: stop.signal });
    wait();
    // Google refused the sign-in: forget it here, and for the other projects unless one has a newer one already.
    if (r.status === 401) { if (!as) { if (get(KT)?.token === tok.token) put(KT, null); tok = null; } throw { auth: true }; }
    // Why Drive said no, as Google's Drive API guide "Resolve errors" names it: storageQuotaExceeded, rateLimitExceeded…
    if (!r.ok) throw { http: r.status, reason: await r.json().then(x => x?.error?.errors?.[0]?.reason || '', () => '') };
    if (r.status === 204) return null;
    if (!r.body?.getReader) return await r.json();
    const reader = r.body.getReader(), dec = new TextDecoder();
    let text = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; wait(); text += dec.decode(value, { stream: true }); }
    return JSON.parse(text + dec.decode());
  } catch (e) {
    throw e?.name === 'AbortError' ? { http: 0 } : e;
  } finally { clearTimeout(timer); }
}
const query = meta => {
  const [k, v] = Object.entries(meta.appProperties)[0];
  return encodeURIComponent(`appProperties has { key='${k}' and value='${v}' } and trashed=false`);
};
async function findAll(meta, fields) {
  const x = await api('GET', `drive/v3/files?spaces=drive&orderBy=createdTime&pageSize=10&fields=${encodeURIComponent('files(' + fields + ')')}&q=${query(meta)}`);
  return x?.files || [];
}
async function folder() { // the "Parts Bin" folder, made the first time (or again, if it was deleted)
  const [f] = await findAll(FOLDER, 'id');
  return f ? f.id : (await api('POST', 'drive/v3/files?fields=id', JSON.stringify(FOLDER), 'application/json')).id;
}
async function download(id) {
  // A file that isn't JSON at all is unreadable too, not a sign that Drive can't be reached.
  const raw = await api('GET', `drive/v3/files/${id}?alt=media`).catch(e => { throw e instanceof SyntaxError ? { unreadable: true } : e; });
  if (!raw || raw.app !== APP) throw { unreadable: true };
  return cleanDoc(raw);
}
async function create(body) {
  const dir = await folder(), b = 'pb-' + Date.now().toString(36);
  return api('POST', 'upload/drive/v3/files?uploadType=multipart&fields=id,version',
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ ...FILE, parents: [dir] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`,
    `multipart/related; boundary=${b}`);
}
// Which Google account this sign-in is (null when Drive couldn't say).
function whoami(as = null) {
  return api('GET', 'drive/v3/about?fields=' + encodeURIComponent('user(displayName,emailAddress)'), undefined, undefined, as)
    .then(x => ({ email: x?.user?.emailAddress || '', name: x?.user?.displayName || '' }), () => null);
}
function remember(u) {
  if (!u) return;
  st.email = u.email; st.name = u.name; saveSt();
  if (tok) { tok.email = st.email; put(KT, tok); } // so the next junkdrawer.works project can skip the account chooser
}

// Drive asking us to slow down (Google's guide says to wait and try again), or having a moment: tried once more.
const isBusy = e => e?.http === 429 || (e?.http === 403 && /rateLimitExceeded/i.test(e.reason || '')) || [500, 502, 503, 504].includes(e?.http);
const BACKOFF = () => +window.__driveBackoff || 3000 + Math.random() * 2000;

// One sync: read the Drive copy, merge, write back what changed on either side.
// lost: the file has already gone once mid-sync; waited: Drive has already been given a few seconds once.
async function run(tries, lost = false, waited = false) {
  const local = readLocal(), localText = canon(local);
  try {
    const files = await findAll(FILE, 'id,version');
    let file = files[0] || null, remote = file ? await download(file.id) : null;
    // Two devices that each made the file at the same moment: fold the extras into the first and bin them.
    for (const extra of files.slice(1)) {
      remote = mergeDocs(remote, await download(extra.id), { first: true });
      await api('PATCH', `drive/v3/files/${extra.id}`, JSON.stringify({ trashed: true }), 'application/json');
    }
    // A device's first sync with this file (or a file made fresh after the old one was deleted) takes
    // the union: nothing on either side counts as removed.
    const first = !file || st.fileId !== file.id;
    const merged = remote ? mergeDocs(local, remote, { first }) : local, out = canon(merged);
    if (!file) file = await create(out);
    else if (canon(remote) !== out || files.length > 1) {
      // Another device may have saved since we read it; then start over with its version.
      const v = await api('GET', `drive/v3/files/${file.id}?fields=version`);
      if (String(v.version) !== String(file.version)) throw RETRY;
      const wrote = await api('PATCH', `upload/drive/v3/files/${file.id}?uploadType=media&fields=id,version`, out, 'application/json');
      // Drive can't refuse a write that was based on an older version, so look again: if another device
      // wrote straight after us, go round again so nothing of ours is lost. (If one still slips through,
      // this device keeps its changes and puts them back at its next sync.)
      const after = await api('GET', `drive/v3/files/${file.id}?fields=version`);
      if (String(after.version) !== String(wrote.version)) throw RETRY;
    }
    if (canon(readLocal()) !== localText) throw RETRY; // saved here meanwhile: merge again
    const changed = out !== localText;
    st.fileId = file.id;
    // This browser's storage is full: Drive has the merged copy, so nothing is lost, but this isn't synced, and says so.
    if (changed) { try { localStorage.setItem(KEY, out); } catch { saveSt(); throw FULL; } }
    st.last = Date.now(); saveSt();
    return changed;
  } catch (e) {
    if (e === RETRY && tries < 4) return run(tries + 1, lost, waited);
    // the file (or its folder) went between finding it and writing it, deleted on another device: once more finds it
    // again or makes it afresh
    if (e?.http === 404 && !lost) return run(tries, true, waited);
    if (isBusy(e) && !waited) { await new Promise(r => setTimeout(r, BACKOFF())); return run(tries, lost, true); }
    throw e;
  }
}

function sync() {
  if (!CLIENT_ID || !st.on) return Promise.resolve(false);
  if (!live()) { signedOut(); return Promise.resolve(false); }
  if (busy) { again = true; return busy; }
  if (navigator.onLine === false) { setStatus('offline', OFFLINE); return Promise.resolve(false); } // the 'online' event syncs
  setStatus('busy');
  busy = run(0).then(changed => {
    setStatus('ok');
    if (changed) ups.forEach(f => { try { f(); } catch (e) { console.error('Parts Bin: showing synced changes failed', e); } });
    return changed;
  }, e => {
    if (e?.auth) setStatus('tap');
    else if (e === FULL) setStatus('error', 'This browser’s storage is full, so what Drive brought in wasn’t kept here.' + (get(INBOX)?.batches?.length ? ' Dismiss what’s waiting in the Inbox to make room.' : ''));
    else if (e?.reason === 'storageQuotaExceeded') setStatus('error', 'Your Google Drive is full, so the inventory wasn’t saved there. It’s kept on this device. Free some space in Drive, then tap Sync now.');
    else if (isBusy(e)) setStatus('error', 'Google Drive is busy. Try again in a minute.');
    // no connection at all (a request that never answers is something else: Drive not reached, below)
    else if (navigator.onLine === false || e instanceof TypeError) setStatus('offline', OFFLINE);
    else if (e?.unreadable) setStatus('error', 'The file in your Drive isn’t readable, so it was left alone. Save a backup here, then delete that file from the Parts Bin folder to start it fresh.');
    else setStatus('error', e === RETRY ? 'Another device kept saving. Try again in a moment.' : 'Couldn’t reach Google Drive. Check the connection and try again.');
    return false;
  }).then(changed => {
    busy = null;
    if (again) { again = false; return sync(); }
    return changed;
  });
  return busy;
}

// ---------- signing in (Google Identity Services, in a pop-up) ----------
function loadGis() {
  if (!CLIENT_ID || client) return;
  if (window.google?.accounts?.oauth2) { init(); return; }
  if (gisLoading) return;
  gisLoading = true;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = init;
  s.onerror = () => { gisLoading = false; setStatus(st.on ? 'tap' : 'off', 'Google sign-in didn’t load. Check the connection.'); };
  document.head.append(s);
}
function init() {
  if (client) return;
  client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPE, callback: gotToken,
    error_callback: e => setStatus(st.on ? 'tap' : 'off', e?.type === 'popup_closed' ? '' : 'Google sign-in didn’t finish.'),
  });
  setStatus(status, note);
}
function gotToken(r) {
  if (!r || r.error || !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
    setStatus(st.on ? 'tap' : 'off', 'Google Drive wasn’t allowed, so nothing was saved there. Try again and leave the Drive box ticked.');
    return;
  }
  const t = { token: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000, scope: r.scope || SCOPE, email: st.email };
  st.on = true; saveSt();
  setStatus('busy'); // a good sign-in: what went wrong last time no longer says so
  // Which account it is, before it's used for anything: someone with two Google accounts can pick the other one in
  // Google's window, and the whole inventory would be copied into that account's Drive while this still named the first.
  whoami(t).then(u => {
    if (u?.email && st.email && u.email.toLowerCase() !== st.email.toLowerCase()) {
      // not taken on, here or for the other projects, so nothing syncs to that Drive
      setStatus('tap', `You signed in as ${u.email}, but this device saves to ${st.email}’s Drive. Sign in as ${st.email}, or stop saving here and turn it on again to use the other account.`);
      return;
    }
    tok = t; put(KT, t); remember(u);
    return sync();
  });
}
// Turn it on. With a sign-in from any junkdrawer.works project still good, no Google window at all.
function start() {
  if (!CLIENT_ID) return;
  tok = get(KT);
  if (!live()) { signIn(); return; }
  st.on = true; if (!st.email && tok.email) st.email = tok.email; saveSt();
  setStatus('busy');
  (st.email ? Promise.resolve() : whoami().then(remember)).then(sync);
}
// Google only opens its window from a tap, so this has to run inside a click handler.
function signIn() {
  if (!client) { loadGis(); setStatus(status, 'Google sign-in is still loading. Tap again in a second.'); return; }
  const hint = st.email || tok?.email || '';
  client.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: 'select_account' });
}
// Stop on this device. The shared sign-in stays for the other projects, and nothing is revoked:
// revoking would cancel Google's permission for every project on this client.
function stop() {
  clearTimeout(pushT);
  st = fresh(); saveSt(); setStatus('off');
}
function now() { if (!st.on) start(); else if (!live()) signIn(); else sync(); } // inside a tap

// ---------- the bits of page ----------
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const lastSynced = () => (st.last ? ` Last synced ${ago(st.last)}.` : '');
function title() {
  return status === 'busy' ? 'Syncing with Google Drive'
    : status === 'tap' ? (note ? note + ' Tap to sign in to Google again.' : 'Tap to sign in to Google again and sync.') + lastSynced()
      : status === 'error' ? note + lastSynced() + ' Tap to try again.'
        : status === 'offline' ? note + lastSynced()
          : 'Synced with Google Drive' + (st.last ? ' ' + ago(st.last) : '') + '. Tap to sync now.';
}
const CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18.5h10.5a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.7 9.1 4.7 4.7 0 0 0 7 18.5z"/></svg>';

// The header button: a cloud with a dot, green when synced, amber while syncing, red when it needs a tap, grey offline.
function chip(btn) {
  if (!btn) return;
  if (!CLIENT_ID) { btn.hidden = true; return; }
  btn.innerHTML = CLOUD + '<i class="dot"></i>';
  btn.addEventListener('click', now);
  watch(() => {
    btn.hidden = !st.on;
    btn.dataset.s = status;
    btn.title = title();
    btn.setAttribute('aria-label', title());
  });
}

// The settings card: turn it on, see where it's saving, sync now, or stop.
function card(host) {
  if (!host) return;
  if (!CLIENT_ID) { host.hidden = true; return; }
  loadGis();
  host.hidden = false;
  let armed = false;
  const line = () => status === 'busy' ? 'Syncing now.'
    // what went wrong signing in, when something did (Drive not allowed, the window not finishing); otherwise the hour
    : status === 'tap' ? (note ? esc(note) : 'Google signs you out after an hour. Tap <b>Sync now</b> to sign back in; your changes are safe here meanwhile.') + lastSynced()
      : status === 'error' || status === 'offline' ? esc(note) + lastSynced()
        : lastSynced().trim();
  function draw() {
    if (!host.isConnected) return false; // the screen it was on has gone
    host.innerHTML = st.on
      ? `<h3>${status === 'error' || status === 'tap' ? 'Google Drive: not synced' : 'Saved to Google Drive'}</h3>
        <p class="muted">Your inventory is saved to <b>${esc(st.email || 'your Google Drive')}</b>, in a folder called “Parts Bin”, and shows up on every device where you turn this on. ${line()}</p>
        <div class="row"><button class="btn" type="button" data-a="now"${status === 'busy' ? ' disabled' : ''}>Sync now</button>
        <button class="btn" type="button" data-a="off">${armed ? 'Tap again to stop' : 'Stop saving on this device'}</button></div>`
      : `<h3>Save across devices</h3>
        <p class="muted">Keep the inventory in your own Google Drive and it’s the same on every phone and computer where you turn this on. It goes in a “Parts Bin” folder, and junkdrawer.works can’t see anything else in your Drive. <a href="https://junkdrawer.works/privacy.html">Privacy</a></p>
        ${note ? `<p class="err">${esc(note)}</p>` : ''}
        <div class="row"><button class="btn primary" type="button" data-a="on">Save to Google Drive</button></div>`;
    host.querySelectorAll('button[data-a]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'on') start();
      else if (a === 'now') now();
      else if (!armed) { armed = true; draw(); }
      else { armed = false; stop(); }
    }));
  }
  watch(draw);
}
function watch(f) { watchers.push(f); f(); }

// The page saved something: send it along shortly, or straight away (wait: false) when other devices need to know at
// once (a bag number given out).
function changed(wait = true) {
  if (!CLIENT_ID || !st.on) return;
  clearTimeout(pushT);
  if (!live()) signedOut();
  else if (wait) pushT = setTimeout(sync, 1200);
  else sync();
}
// Bring in what other devices saved, now: before a bag number handed out here is used. A sync already under way goes
// round once more after it (sync()), so this never runs two at once.
function pull() { if (CLIENT_ID && st.on && live()) sync(); }

export const drive = {
  ready: !!CLIENT_ID,
  isOn: () => !!CLIENT_ID && st.on,
  status: () => status, // off, busy, ok, tap (sign in again), error, offline
  last: () => st.last, // when it last synced, ms (0: never)
  chip, card, changed, now, stop, pull,
  push: () => changed(false),
  onUpdate(f) { ups.push(f); }, // synced data landed in localStorage
  watch(f) { if (CLIENT_ID) watch(f); }, // Drive turned on or off, or synced; return false to stop watching
};

if (CLIENT_ID) {
  if (st.on) {
    loadGis(); // ready before the first tap
    status = live() ? 'ok' : 'tap';
    if (live()) setTimeout(sync, 0);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && st.on && live() && Date.now() - st.last > 30000) sync(); });
  setInterval(() => { if (!document.hidden && st.on) { if (live()) sync(); else signedOut(); } }, 5 * 60000);
  window.addEventListener('online', () => { if (st.on && live()) sync(); }); // the signal's back: no wait for the next round
  window.addEventListener('storage', e => { // another tab signed in, stopped, or synced
    if (e.key === KS || e.key === KT) {
      st = { ...fresh(), ...(get(KS) || {}) }; tok = get(KT);
      setStatus(st.on ? (busy ? 'busy' : live() ? 'ok' : 'tap') : 'off');
      if (st.on) loadGis();
    }
  });
}
