// Optional: identifying a part from a photo, and smarter BOM matching, using the person's own Anthropic
// API key. The key stays in this browser (localStorage) and is sent only to api.anthropic.com.
// Without a key, everything still works from the inventory search.
import * as PID from './photoid.js';

const KEY = 'parts-bin.ai';
const get = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const RETIRED = ['claude-sonnet-4-5']; // a saved choice that Anthropic has since retired moves to the default

export const ai = {
  get key() { return get().key || ''; },
  get model() { const m = get().model; return !m || RETIRED.includes(m) ? DEFAULT_MODEL : m; },
  save({ key, model }) {
    try { localStorage.setItem(KEY, JSON.stringify({ key: String(key || '').trim(), model: String(model || '').trim() || DEFAULT_MODEL })); } catch {}
  },
  get on() { return !!this.key; },
};

async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
async function jpeg(file, max = 1280) {
  try {
    const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.82));
  } catch { return file; }
}

const API = 'https://api.anthropic.com/v1/messages';
const headers = beta => ({ 'content-type': 'application/json', 'x-api-key': ai.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...(beta ? { 'anthropic-beta': beta } : {}) });
// One request; a refusal by the API comes back as {code, message} (photoid.js says what each means), with the status.
async function post(body, beta = '') {
  let r;
  try { r = await fetch(API, { method: 'POST', headers: headers(beta), body: JSON.stringify(body) }); }
  catch { throw navigator.onLine === false ? { code: 'offline', message: 'Needs a connection.' } : { code: 'network', message: 'Couldn’t reach the Anthropic API.' }; }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error?.message || ''; } catch {} throw { ...PID.errorFor(r.status, m), status: r.status, raw: m }; }
  return r.json();
}

// Settings' Test key: the smallest request there is, on the model in Settings, so a mistyped model shows up too.
export async function testKey() {
  await post({ model: ai.model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] });
  return true;
}

// Reads parts off a photo (mode 'bags' or 'receipt'), or details for parts already listed ('details'), in one request.
// Returns {items, left_out, cut}: cut when the answer ran out of room even at double max_tokens, and items is what was
// complete by then. where: 'pack' for Pack's one bag (a smaller photo and answer), else 'inbox'.
export async function readParts({ mode, file = null, desc = '', bin = '', parts = [], inventory, where = 'inbox' }) {
  if (!ai.on) throw { code: 'no_key', message: 'Add an API key in Settings first.' };
  let image = null;
  if (file) { const img = await jpeg(file, PID.imageEdge(mode, where)); image = { media_type: img.type || 'image/jpeg', data: await toBase64(img) }; }
  let max = PID.maxTokens(mode, where), structured = true, fallback = PID.wantsFallback(ai.model), retried = false;
  for (;;) { // each retry below changes one thing, at most once
    const body = PID.request({ model: ai.model, mode, inventory, image, bin, desc, parts, max, structured, fallback });
    let j;
    try { j = await post(body, fallback ? PID.FALLBACK_BETA : ''); }
    catch (e) {
      // a model that doesn't take the fallback, or structured outputs: the same request without it, once each
      if (e.status === 400 && fallback && PID.refusesFallback(e.raw)) { fallback = false; continue; }
      if (e.status === 400 && structured && PID.refusesFormat(e.raw)) { structured = false; continue; }
      throw e;
    }
    if (j.stop_reason === 'refusal') throw { code: 'refused', message: 'Claude declined that one.' };
    const { data, whole } = PID.readText(PID.replyText(j));
    if (j.stop_reason === 'max_tokens' && !retried) { retried = true; max *= 2; continue; } // once, at double
    if (!whole && j.stop_reason !== 'max_tokens') throw { code: 'invalid_json', message: 'The answer couldn’t be read. Try again.' };
    return { items: Array.isArray(data.items) ? data.items : [], left_out: Array.isArray(data.left_out) ? data.left_out.map(String) : [], cut: j.stop_reason === 'max_tokens' };
  }
}

// Same shape as the Stockroom artifact's sample.json(prompt, {images}), so the screens didn't change.
export function makeSample() {
  if (!ai.on) return null;
  async function ask(prompt, opts = {}) {
    const content = [];
    if (opts.images) {
      const img = await jpeg(opts.images);
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64(img) } });
    }
    content.push({ type: 'text', text: prompt });
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ai.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        // Room for the thinking as well as the answer: the default model thinks first (adaptive, effort high, when
        // `thinking` isn't sent), and that counts against max_tokens. 1,500 could be used up before the answer began.
        // No effort is sent: the model can be changed in Settings, and some older models refuse it. A long BOM asks for more
        // (opts.maxTokens), as its answer has a line for each of its lines.
        body: JSON.stringify({ model: ai.model, max_tokens: opts.maxTokens || 16000, messages: [{ role: 'user', content }] }),
      });
    } catch { throw { code: 'network', message: 'Couldn’t reach the Anthropic API.' }; }
    if (r.status === 401) throw { code: 'not_granted', message: 'The API key was refused. Check it in Settings.' };
    if (r.status === 429) throw { code: 'rate_limited', message: 'Too many requests. Wait a moment.' };
    if (!r.ok) { let m = ''; try { m = (await r.json()).error?.message || ''; } catch {} throw { code: 'error', message: m || 'The API answered ' + r.status }; }
    const j = await r.json();
    // An answer cut off, or declined, says so, rather than reading as one that wasn't understood
    if (j.stop_reason === 'max_tokens') throw { code: 'cut_off', message: 'The answer was cut off. Try again with fewer lines.' };
    if (j.stop_reason === 'refusal') throw { code: 'refused', message: 'Claude declined that one.' };
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const sample = async (prompt, opts) => ({ text: await ask(prompt, opts), truncated: false });
  sample.json = async (prompt, opts) => {
    const text = await ask(prompt + '\n\nReply with only the JSON, no other text.', opts);
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = m ? m[1] : text.slice(Math.min(...['{', '['].map(c => text.indexOf(c)).filter(i => i >= 0)), Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1);
    try { return JSON.parse(body); } catch { throw { code: 'invalid_json', message: 'The answer wasn’t readable.', text }; }
  };
  sample.limits = async () => ({ images: { maxCount: 1 } });
  return sample;
}
