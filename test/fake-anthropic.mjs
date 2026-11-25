// A stand-in for the Anthropic Messages API, for testing reading parts in the page without a key or the network.
// Like fake-google.mjs: install it on a Playwright browser context, and every request to api.anthropic.com comes here.
//
//   import { fakeAnthropic } from './fake-anthropic.mjs';
//   const api = fakeAnthropic();
//   await api.install(ctx);
//   api.photo = 'five';        // what a photo of bags shows next: 'one' or 'five'
//   api.next.push({ status: 401, error: 'invalid x-api-key' }); // the next answers, in order, before the canned ones
//   … api.calls holds every request body.
//
// The answers are canned replies for one part, five parts, a receipt and a details batch, in the shape the app asks for:
// the JSON the schema in output_config.format describes, as the reply's text, after an (empty) thinking block.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

export const ONE = { items: [{ name: 'BME280 (Adafruit)', match: 'p-bme280', matchConfidence: 0.92, category: 'Sensors', mpn: 'BME280', qty: 2, iface: ['I2C', 'SPI'], addr: '0x77, 0x76', volts: '3–5 V', logic: '3.3 V or 5 V', box: [0.1, 0.1, 0.9, 0.9] }], left_out: [] };
export const FIVE = { items: [
  { name: 'BME280 (Adafruit)', match: 'p-bme280', matchConfidence: 0.9, qty: 2, mpn: 'BME280', box: [0.02, 0.1, 0.18, 0.9] },
  { name: 'SCD41 CO2 sensor', match: 'p-scd41', matchConfidence: 0.55, qty: 1, mpn: 'SCD41', iface: ['I2C'], addr: '0x62', box: [0.22, 0.1, 0.38, 0.9] }, // not sure enough: a check, not a match
  { name: 'TCA9548A I2C multiplexer', category: 'Sensors', mpn: 'TCA9548A', qty: 3, iface: ['I2C'], addr: '0x70–0x77', volts: '1.65–5.5 V', notes: '8-channel I2C mux', link: 'https://made-up.example/tca', img: 'https://made-up.example/tca.jpg', box: [0.42, 0.1, 0.58, 0.9] },
  { name: 'HW-611 pressure sensor', category: 'Sensors', qty: 4, iface: ['I2C', 'SPI'], volts: '3.3 V', tags: ['generic'], check: 'Bench Identifier Port A: ID 0x58 at 0xD0 is a BMP280, 0x60 a BME280.', box: [0.62, 0.1, 0.78, 0.9] },
  { name: 'Relay module, 1 channel', category: 'Power', qty: 1, volts: '5 V', logic: '5 V', check: 'Relay boards switch mains: check the coil voltage before wiring it.', box: [0.82, 0.1, 0.98, 0.9] },
  { name: 'HW-611 pressure sensor', category: 'Sensors', qty: 2, iface: ['I2C'] }, // the same part twice: one card, 6 of them
], left_out: ['A loose jumper wire: not a part'] };
export const RECEIPT = { items: [
  { name: 'TCA9548A I2C multiplexer', match: 'p-tca', matchConfidence: 0.95, qty: 4, mpn: 'TCA9548A' },
  { name: 'M3 heat-set inserts', category: 'Hardware', qty: 100 },
], left_out: ['Shipping', 'Sales tax'] };
// Details: for each part asked about, what's suggested for it (by id), as the reply would have it, including what the
// app must ignore (a count, a new name, a part that wasn't asked about).
export const DETAILS = {
  'p-loose': { category: 'Sensors', mpn: 'BH1750', iface: ['I2C'], addr: '0x23, 0x5C', volts: '3–5 V', qty: 99, name: 'Renamed' },
  'p-bare2': { category: 'Displays', iface: ['I2C'], addr: '0x3C', check: 'Bench Identifier Port A: an SSD1306-class OLED shows at 0x3C.' },
  'p-other': { volts: '5 V' },
};

export function fakeAnthropic() {
  const api = { calls: [], next: [], photo: 'five', hold: null };
  const reply = (body, data, { stop = 'end_turn', text = null } = {}) => ({
    id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: stop,
    content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: text ?? JSON.stringify(data) }],
    usage: { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 8000 },
  });
  async function handle(route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = req.postDataJSON(); api.calls.push(body);
    if (api.hold) await api.hold;
    const send = (status, json) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(json) });
    const next = api.next.shift();
    if (next?.status) return send(next.status, { type: 'error', error: { type: 'error', message: next.error || '' } });
    if (next?.stop || next?.text != null) return send(200, reply(body, null, next));
    const text = body.messages?.[0]?.content?.at?.(-1)?.text || '';
    const mode = /Mode: (\w+)/.exec(text)?.[1];
    if (mode === 'bags') return send(200, reply(body, api.photo === 'one' ? ONE : FIVE));
    if (mode === 'receipt') return send(200, reply(body, RECEIPT));
    if (mode === 'details') {
      const asked = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)).map(p => p.id);
      return send(200, reply(body, { items: [...asked, 'p-other'].filter(id => DETAILS[id]).map(id => ({ id, ...DETAILS[id] })), left_out: [] }));
    }
    return send(200, reply(body, null, { text: 'x' })); // Test key, and anything else: a short answer
  }
  api.install = ctx => ctx.route('https://api.anthropic.com/**', handle);
  return api;
}
