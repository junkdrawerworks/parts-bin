// BOM check: reading a pasted parts list, and finding each line in the inventory.  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, parseBom, matchPart, isPartNumber, shortBy, needs, inPartUnit, unitOf } from '../js/bom.js';

test('norm folds the ways a name can be typed', () => {
  // search, bags and BOM check all read names through it
  assert.equal(norm('ESP32-S3'), 'esp32 s3');
  assert.equal(norm('SCD41 CO₂ sensor'), 'scd41 co2 sensor', 'a subscript is the digit, not a gap');
  assert.equal(norm('ＥＳＰ３２'), 'esp32', 'full-width letters, as some phone keyboards type them');
  assert.equal(norm('100µF capacitor'), '100uf capacitor');
  assert.equal(norm('100μF capacitor'), '100uf capacitor', 'micro sign or Greek mu');
  assert.equal(norm('10kΩ resistor'), '10k resistor');
  assert.equal(norm('10 kΩ potentiometer'), '10k potentiometer');
  assert.equal(norm('220Ω resistor'), '220 resistor');
  assert.equal(norm('220 ohm resistors'), '220 resistors');
  assert.equal(norm('4.7k Ohms'), '4.7k');
  assert.equal(norm('40mm speaker 4 ohm'), '40mm speaker 4');
  assert.equal(norm('Ohm’s law kit'), 'ohm s law kit', 'only an ohm after a number is dropped');
  assert.equal(norm(null), '');
});

test('a count first or last, or none', () => {
  assert.deepEqual(parseBom('2x XIAO ESP32-S3\n1 SCD41 breakout\n3 WS2812 strip segment\nM3 heat-set inserts x8\nSCD41 ×1\nLED strip, 3\nProto board\n# a note\n\n'), [
    { qty: 2, name: 'XIAO ESP32-S3' }, { qty: 1, name: 'SCD41 breakout' }, { qty: 3, name: 'WS2812 strip segment' },
    { qty: 8, name: 'M3 heat-set inserts' }, { qty: 1, name: 'SCD41' }, { qty: 3, name: 'LED strip' }, { qty: 1, name: 'Proto board' },
  ]);
  assert.deepEqual(parseBom('2 BME280; 1 SGP30'), [{ qty: 2, name: 'BME280' }, { qty: 1, name: 'SGP30' }]);
});

test('a part name can start with a digit', () => {
  assert.deepEqual(parseBom('1N4148 diodes x 4\n74HC595 x2\n2N2222 transistor, 5\n18650 cells ×2\n0.96in OLED x2\n2N7000\n10 1N4148 diodes'), [
    { qty: 4, name: '1N4148 diodes' }, { qty: 2, name: '74HC595' }, { qty: 5, name: '2N2222 transistor' }, { qty: 2, name: '18650 cells' },
    { qty: 2, name: '0.96in OLED' }, { qty: 1, name: '2N7000' }, { qty: 10, name: '1N4148 diodes' },
  ]);
  // a count before the name still reads as one, with or without the x
  assert.deepEqual(parseBom('4 x 18650\n2 M3x8\n2 18650 cells\n2x 74HC595'), [
    { qty: 4, name: '18650' }, { qty: 2, name: 'M3x8' }, { qty: 2, name: '18650 cells' }, { qty: 2, name: '74HC595' },
  ]);
});

test('a size is part of the name, not a count', () => {
  // a pin header's rows by pins and a screw's size by length: 1x40 is one 40-pin header, M3x8 one size of screw
  assert.deepEqual(parseBom('Pin header 1x40\nFemale header 2x20\nScrews M3x8\nSocket head M2.5x6\n2 Header 1x8\nM3x8'), [
    { qty: 1, name: 'Pin header 1x40' }, { qty: 1, name: 'Female header 2x20' }, { qty: 1, name: 'Screws M3x8' },
    { qty: 1, name: 'Socket head M2.5x6' }, { qty: 2, name: 'Header 1x8' }, { qty: 1, name: 'M3x8' },
  ]);
  // a part number with a count after it still counts
  assert.deepEqual(parseBom('SCD41x2\nWS2812x10\n74HC595*3'), [{ qty: 2, name: 'SCD41' }, { qty: 10, name: 'WS2812' }, { qty: 3, name: '74HC595' }]);
  // and a word ending in x isn't a count
  assert.deepEqual(parseBom('Junction Box2'), [{ qty: 1, name: 'Junction Box2' }]);
});

test('a count marked at the end beats a number at the start', () => {
  assert.deepEqual(parseBom('18650 cells×2\n18650 cells x2\n7805 regulator ×3'), [
    { qty: 2, name: '18650 cells' }, { qty: 2, name: '18650 cells' }, { qty: 3, name: '7805 regulator' },
  ]);
});

test('a long number before one word is the part’s name', () => {
  assert.deepEqual(parseBom('555 timer\n7805 regulator\n18650 cells\n2 555 timer\n3 timer\n12 resistors\n100 M3 screws'), [
    { qty: 1, name: '555 timer' }, { qty: 1, name: '7805 regulator' }, { qty: 1, name: '18650 cells' }, { qty: 2, name: '555 timer' },
    { qty: 3, name: 'timer' }, { qty: 12, name: 'resistors' }, { qty: 100, name: 'M3 screws' },
  ]);
});

test('a list pasted with bullets keeps its counts', () => {
  assert.deepEqual(parseBom('- 2x XIAO ESP32-S3\n• 1 SCD41\n* M3 heat-set inserts x8\n-'), [
    { qty: 2, name: 'XIAO ESP32-S3' }, { qty: 1, name: 'SCD41' }, { qty: 8, name: 'M3 heat-set inserts' },
  ]);
});

test('each line finds the part that holds most of its words', () => {
  const parts = [
    { id: 'xiao', name: 'Seeed XIAO ESP32-S3', tags: ['esp32'] },
    { id: 'bme', name: 'BME280 (Adafruit)' },
    { id: 'm3', name: 'M3 heat-set inserts' },
  ];
  assert.equal(matchPart('XIAO ESP32-S3', parts).p.id, 'xiao');
  assert.equal(matchPart('XIAO ESP32-S3', parts).conf, 1);
  assert.equal(matchPart('BME280', parts).p.id, 'bme');
  assert.equal(matchPart('heat-set inserts', parts).p.id, 'm3');
  assert.equal(matchPart('SGP30', parts), null);
  assert.equal(matchPart('', parts), null);
});

test('a part number decides the match', () => {
  for (const w of ['scd41', '1n4148', 'esp32', '3.3v', '74hc595', 'm3x8']) assert.ok(isPartNumber(w), w);
  for (const w of ['100uf', '40pin', '1000mah', '2.54mm', '22awg', '18650', 's3', '10k', 'breakout']) assert.ok(!isPartNumber(w), w);
  // the placeholder's own example: SCD41 is 5 of the line's 13 letters, but it's the part (shown as fuzzy)
  const scd = [{ id: 'scd41', name: 'SCD41', tags: ['generic'] }];
  assert.equal(matchPart('SCD41 breakout', scd).p.id, 'scd41');
  assert.equal(matchPart('SCD41 breakout', scd).conf, 0.6);
  // a line that names one part doesn't match another on the words around it
  assert.equal(matchPart('BME280 breakout', [{ id: 'bmp', name: 'BMP280 breakout' }]), null);
  assert.equal(matchPart('BME280 breakout board', [{ id: 'bmp', name: 'BMP280 breakout board' }]), null);
  assert.equal(matchPart('3.3V regulator', [{ id: 'r5', name: '5V regulator' }]), null);
  assert.equal(matchPart('3.3V regulator', [{ id: 'r5', name: '5V regulator' }, { id: 'r33', name: 'AMS1117 3.3V regulator' }]).p.id, 'r33');
  // the part number can be in the name, the part number field or the tags
  assert.equal(matchPart('BMP280 breakout', [{ id: 'hw', name: 'HW611 (BMP280)' }]).p.id, 'hw');
  assert.equal(matchPart('BMP280 breakout', [{ id: 'hw', name: 'HW-611 pressure sensor', mpn: 'BMP280' }]).p.id, 'hw');
  assert.equal(matchPart('ESP32 board', [{ id: 'x', name: 'Seeed XIAO', tags: ['esp32'] }]).p.id, 'x');
  // of two parts with the number, the one that holds more of the line wins
  assert.equal(matchPart('BME280 breakout (Adafruit)', [{ id: 'g', name: 'BME280' }, { id: 'a', name: 'BME280 breakout (Adafruit)' }]).p.id, 'a');
});

test('a number with a unit, and a line of plain words, match as before', () => {
  assert.equal(matchPart('40pin header', [{ id: 'h', name: 'Male header 40 pin' }]).p.id, 'h');
  assert.equal(matchPart('100uF capacitor', [{ id: 'c', name: '100 uF electrolytic capacitor' }]).p.id, 'c');
  assert.equal(matchPart('2.54mm header', [{ id: 'h', name: 'Pin header 2.54 mm' }]).p.id, 'h');
  assert.equal(matchPart('heat shrink tubing 3mm', [{ id: 'hs', name: 'Heat shrink tubing 3mm' }]).conf, 1);
  assert.equal(matchPart('silicone wire', [{ id: 'w', name: 'Silicone wire 22AWG' }]).p.id, 'w');
  assert.equal(matchPart('red hookup wire', [{ id: 'w', name: 'Silicone wire 22AWG' }]), null, 'under half of the words');
});

test('a part without the line’s value or variant is only a fuzzy match', () => {
  const parts = [{ id: 'r10k', name: '10k resistor' }, { id: 's3', name: 'Seeed XIAO ESP32-S3' }, { id: 'c10', name: '10uF capacitor' }, { id: 'ins', name: 'M2 heat-set inserts' }];
  // it can still be offered, but under 0.8, so BOM check marks it fuzzy (a 10k for a 1k showed as sure)
  for (const line of ['1k resistor', '4.7k resistor', 'ESP32-C3', '100uF capacitor', 'M3 heat-set inserts']) {
    const m = matchPart(line, parts); assert.ok(m && m.conf < 0.8, `${line}: ${m?.p.name} at ${m?.conf}`);
  }
  // the right value is sure, however it's spaced, and is picked over the wrong one
  assert.equal(matchPart('10k resistor', parts).conf, 1);
  assert.equal(matchPart('ESP32-S3', parts).conf, 1);
  assert.equal(matchPart('100uF capacitor', [{ id: 'c', name: '100 uF capacitor' }]).conf, 1);
  assert.equal(matchPart('40pin header', [{ id: 'h', name: 'Male header 40 pin' }]).conf, 1);
  assert.equal(matchPart('1k resistor', [...parts, { id: 'r1k', name: '1k resistor' }]).p.id, 'r1k');
  assert.equal(matchPart('ESP32-C3', [...parts, { id: 'c3', name: 'ESP32-C3 SuperMini' }]).p.id, 'c3');
});

test('lines that need the same part add up', () => {
  const ins = { id: 'ins', name: 'M3 heat-set inserts', qty: 6 }, tube = { id: 'hs', name: 'Heat shrink tubing', qty: 0.1 };
  const n = needs([{ qty: 2, m: { p: ins } }, { qty: 6, m: { p: ins } }, { qty: 1, m: null }, { qty: 0.1, m: { p: tube } }, { qty: 0.2, m: { p: tube } }]);
  assert.deepEqual(n.get('ins'), { qty: 8, lines: 2 });
  assert.deepEqual(n.get('hs'), { qty: 0.3, lines: 2 }, 'to the thousandth, as shortBy');
  assert.equal(n.size, 2, 'a line with no part isn’t counted');
});

test('a shortfall in metres or grams reads as a person would write it', () => {
  assert.equal(shortBy(0.3, 0.1), 0.2);
  assert.equal(shortBy(1.25, 0.5), 0.75);
  assert.equal(shortBy(5, 2), 3);
});

// A workroom's worth of parts, named the way the Parts Bin skill names them. Where two parts could tie, the wrong one
// comes first, as a tie used to go to whichever came first.
const P = (id, name, o = {}) => ({ id, name, qty: 10, unit: 'pcs', tags: [], ...o });
const INV = [
  P('r10', '10 resistor 1/4W', { tags: ['resistor', 'tht'] }), P('r100', '100 resistor 1/4W', { tags: ['resistor', 'tht'] }),
  P('r220', '220 resistor 1/4W', { tags: ['resistor', 'tht'] }), P('r1k', '1k resistor 1/4W', { tags: ['resistor', 'tht'] }),
  P('r1k2', '1.2k resistor 1/4W', { tags: ['resistor', 'tht'] }), P('r10k', '10k resistor 1/4W', { tags: ['resistor', 'tht'] }),
  P('smd220', '220Ω 0805 SMD resistor', { tags: ['smd', '0805'] }), P('pot', '10 kΩ potentiometer'),
  P('c100n', '100nF ceramic capacitor', { tags: ['ceramic'] }), P('c10u', '10uF electrolytic capacitor 25V', { tags: ['electrolytic'] }),
  P('d4148', '1N4148 signal diode', { mpn: '1N4148' }), P('q2222', '2N2222 NPN transistor', { mpn: '2N2222' }),
  P('ne555', 'NE555 timer', { mpn: 'NE555P' }), P('lm358', 'LM358 op amp', { mpn: 'LM358' }), P('lm7805', 'LM7805 5V regulator', { mpn: 'L7805CV' }),
  P('pico', 'Raspberry Pi Pico', { mpn: 'RP2040' }), P('picow', 'Raspberry Pi Pico W', { mpn: 'RP2040' }),
  P('xiao', 'Seeed XIAO ESP32-S3', { tags: ['esp32'] }), P('oled', 'SSD1306 0.96" OLED I2C'),
  P('led5r', '5mm red LED', { tags: ['led', '5mm'] }), P('led3r', '3mm red LED', { tags: ['led', '3mm'] }), P('led5g', '5mm green LED', { tags: ['led', '5mm'] }),
  P('stripa', 'WS2812B LED strip 60/m', { qty: 2.5, unit: 'm', tags: ['neopixel', 'ws2812'] }), P('stripb', 'WS2812B LED strip 144/m', { qty: 0.5, unit: 'm', tags: ['neopixel', 'ws2812'] }),
  P('m3x4', 'M3x4 socket head screw', { tags: ['screw'] }), P('m3x6pan', 'M3x6 pan head screw'), P('m3x8', 'M3x8 socket head screw', { tags: ['screw'] }),
  P('m3x8pan', 'M3x8 pan head screw'), P('m3x10so', 'M3x10 brass standoff'), P('m3x10', 'M3x10 socket head screw', { tags: ['screw'] }),
  P('m2x4', 'M2x4 socket head screw', { tags: ['screw'] }), P('m3lock', 'M3 nylon lock nut'), P('m3nut', 'M3 hex nut'), P('m2nut', 'M2 hex nut'),
  P('st2', 'Screw terminal 2-pin 5mm'), P('st3', 'Screw terminal 3-pin 5mm'),
  P('xh2', 'JST-XH 2-pin connector set'), P('xh4', 'JST-XH 4-pin connector set'), P('ph3', 'JST-PH 3-pin cable female'), P('ph4', 'JST-PH 4-pin cable female'),
  P('dip', 'DIP switch 4-position'), P('jump', 'Dupont jumper wires M-M'), P('jumpf', 'Dupont jumper wires M-F'),
  P('heat', 'Heat shrink tubing 3mm', { qty: 1, unit: 'm' }), P('wire', '22AWG silicone wire red', { qty: 5, unit: 'm' }), P('solder', 'Solder 0.8mm 60/40', { qty: 250, unit: 'g' }),
  P('mhz', 'MH-Z19B CO2 sensor', { mpn: 'MH-Z19B' }), P('scd', 'SCD41 CO₂ sensor', { mpn: 'SCD41' }),
];
// A line as BOM check reads it: its count, and the part it finds. ids: the right part (or any of these); sure: at 0.8 or
// more, so not marked fuzzy.
function reads(line, qty, ids, sure = true) {
  const rows = parseBom(line); assert.equal(rows.length, 1, line);
  const r = rows[0], m = matchPart(r.name, INV), ok = [].concat(ids);
  assert.equal(r.qty, qty, `${line}: read as ${r.qty} × ${r.name}`);
  assert.ok(m && ok.includes(m.p.id), `${line}: found ${m ? `${m.p.name} at ${m.conf}` : 'nothing'}, not ${ok}`);
  if (sure) assert.ok(m.conf >= 0.8, `${line}: ${m.p.name} only at ${m.conf}`);
  return m;
}

test('a plural finds the part named in the singular', () => {
  reads('10k resistors', 1, 'r10k');
  reads('220 ohm resistors', 1, 'r220');
  reads('2 x 220 ohm resistors', 2, 'r220');
  reads('220Ω resistor', 1, 'r220');
  reads('red LEDs', 1, ['led5r', 'led3r']);
  reads('5mm red LEDs', 1, 'led5r');
  reads('M3 nuts', 1, 'm3nut');
  reads('M3 screws', 1, ['m3x4', 'm3x8', 'm3x10']);
  reads('M2 screws', 1, 'm2x4');
  reads('M3x8 screws', 1, ['m3x8', 'm3x8pan']);
  assert.equal(reads('M3x8 socket head screws', 1, 'm3x8').conf, 1);
  reads('4x M3 Nylon locknuts', 4, 'm3lock');
  reads('M3 lock nuts', 1, 'm3lock');
  reads('a couple of 10k resistors', 1, 'r10k', false);
  // es after x, s, ch or sh, and words that only look plural are left alone
  assert.equal(matchPart('junction boxes', [P('box', 'Junction box')])?.p.id, 'box');
  assert.equal(matchPart('tactile switches', [P('sw', '6x6mm tactile switch')])?.p.id, 'sw');
  assert.equal(matchPart('project cases', [P('case', 'Project case')])?.conf, 1);
  assert.equal(matchPart('brass inserts', [P('in', 'Brass insert')])?.conf, 1);
});

test('a short word only matches a whole word', () => {
  // an LED isn't an OLED, a 2k isn't a 1.2k, an M3 isn't an LM358
  assert.notEqual(matchPart('led', INV)?.p.id, 'oled');
  assert.equal(matchPart('led', [P('oled', 'SSD1306 0.96" OLED I2C')]), null);
  assert.ok(matchPart('2k resistor', [P('r1k2', '1.2k resistor 1/4W')]).conf < 0.8, '2k as a sure 1.2k');
  assert.equal(matchPart('2k resistor', [P('r1k2', '1.2k resistor 1/4W'), P('r2k', '2k resistor')]).p.id, 'r2k');
  assert.equal(matchPart('M3', [P('lm358', 'LM358 op amp')]), null);
  assert.notEqual(matchPart('M3', INV)?.p.id, 'lm358');
  // a longer one, or a number, can still sit inside a part number
  reads('7805', 1, 'lm7805');
  reads('555 timer', 1, 'ne555');
  reads('NE555', 1, 'ne555');
  reads('LM358', 1, 'lm358');
  // and a common short form still finds the word it starts
  reads('100nF cap', 1, 'c100n');
  assert.equal(matchPart('10k pot', INV)?.p.id, 'pot');
});

test('pin counts, screw sizes and one-letter models tell parts apart', () => {
  reads('JST-PH 4-pin female', 1, 'ph4');
  reads('JST-PH 4-pin – Female', 1, 'ph4');
  reads('JST XH 4 pin', 1, 'xh4');
  reads('3-pin screw terminal', 1, 'st3');
  reads('3 way screw terminal', 1, 'st3'); // a number before pin or way is the part's, not a count
  reads('4 pin JST XH', 1, 'xh4');
  reads('2x 4-pin JST XH', 2, 'xh4');
  reads('DIP switch 4 position', 1, 'dip');
  assert.ok(matchPart('JST-PH 4-pin female', [P('ph3', 'JST-PH 3-pin cable female')]).conf < 0.8, 'a 3-pin for a 4-pin is a guess');
  reads('Raspberry Pi Pico W', 1, 'picow');
  reads('Pi Pico', 1, 'pico');
  assert.ok(matchPart('Raspberry Pi Pico W', [P('pico', 'Raspberry Pi Pico')]).conf < 0.8, 'a Pico for a Pico W is a guess');
  reads('Dupont jumper wires M-F', 1, 'jumpf');
  // a screw size however it's written
  reads('M3 x 8', 1, ['m3x8', 'm3x8pan']);
  reads('M3 x 8 x4', 4, ['m3x8', 'm3x8pan']);
  reads('M3 x 8mm screw', 1, ['m3x8', 'm3x8pan']);
  reads('M3x8mm socket head screw', 1, 'm3x8');
  reads('4x M3 x 8mm (pan head)', 4, 'm3x8pan');
  reads('7x M3 x 6mm (pan head)', 7, 'm3x6pan');
  reads('Screws M3 x 10', 1, 'm3x10');
  reads('M3x10 standoff', 1, 'm3x10so');
});

test('a part with the line’s pin count or value comes before one with more of its other words', () => {
  // the Adafruit headlight list's "JST-PH 2-pin – Female", with no 2-pin female cable in stock
  const jst = [P('ph3f', 'JST-PH 3-pin cable female'), P('ph2', 'JST-PH 2-pin cable')];
  assert.equal(matchPart('JST-PH 2-pin – Female', jst).p.id, 'ph2');
  assert.ok(matchPart('JST-PH 2-pin – Female', jst).conf < 0.8);
  assert.equal(matchPart('JST-PH 3-pin – Male', jst).p.id, 'ph3f');
  assert.ok(matchPart('JST-PH 3-pin – Male', jst).conf < 0.8, 'male isn’t in female');
});

test('designators in front of a line are its count, and say what kind of part a bare value is', () => {
  // as schematics, forum posts and KiCad's grouped output write them
  assert.deepEqual(parseBom('R1,R2,R3 10k\nR4, R5 220\nC1 C2 100nF\nD1-D4 1N4148\nR10 - R12 4.7k\nR7 1k\nC1, C2 10uF electrolytic'), [
    { qty: 3, name: '10k resistor' }, { qty: 2, name: '220 resistor' }, { qty: 2, name: '100nF capacitor' }, { qty: 4, name: '1N4148 diode' },
    { qty: 3, name: '4.7k resistor' }, { qty: 1, name: '1k resistor' }, { qty: 2, name: '10uF electrolytic' },
  ]);
  reads('R1,R2,R3 10k', 3, 'r10k');
  reads('R4, R5 220', 2, 'r220');
  reads('R4, R5 220 ohm', 2, 'r220');
  reads('C1 C2 100nF', 2, 'c100n');
  reads('D1-D4 1N4148', 4, 'd4148');
  // one alone stays in the name as it was written, and matching looks past it
  reads('LED1 5mm red LED', 1, 'led5r');
  reads('U1 NE555', 1, 'ne555');
  reads('Q1 2N2222', 1, 'q2222');
  reads('J1 Screw terminal 2-pin', 1, 'st2');
  assert.deepEqual(parseBom('LED1 5mm red LED\nU1 NE555'), [{ qty: 1, name: 'LED1 5mm red LED' }, { qty: 1, name: 'U1 NE555' }]);
  // a count given as well is the count
  assert.deepEqual(parseBom('R1, R2 10k x4\n2x R1 10k'), [{ qty: 4, name: '10k resistor' }, { qty: 2, name: 'R1 10k' }]);
  // a part's own name that starts like one isn't a designator, and is still found by all of it
  assert.deepEqual(parseBom('DHT22 sensor\nSCD41\nL298N motor driver\nR2D2 kit\nM3 screws\nD1 mini'), [
    { qty: 1, name: 'DHT22 sensor' }, { qty: 1, name: 'SCD41' }, { qty: 1, name: 'L298N motor driver' }, { qty: 1, name: 'R2D2 kit' },
    { qty: 1, name: 'M3 screws' }, { qty: 1, name: 'D1 mini' },
  ]);
  const boards = [P('d1', 'Wemos D1 mini'), P('c3', 'ESP32-C3 SuperMini'), P('s3', 'ESP32-S3 SuperMini')];
  assert.equal(matchPart('D1 mini', boards).p.id, 'd1');
  assert.equal(matchPart('C3 SuperMini', boards).p.id, 'c3');
  assert.equal(matchPart('C3 SuperMini', boards).conf, 1);
});

test('a length or weight is read with its unit, which leaves the name', () => {
  assert.deepEqual(parseBom('2m of wire\n2 m of wire\n0.5 m LED strip\nWS2812B strip 0.5m\n1.5m 22AWG silicone wire red\nheat shrink 3mm, 30cm\nSolder 20g\n30 g solder\n0.5kg solder\nLED strip (1 m)\n0.8 m heat shrink tubing 3mm\n500mm of heat shrink\n10 ft of wire\n2–3 m of wire'), [
    { qty: 2, unit: 'm', name: 'wire' }, { qty: 2, unit: 'm', name: 'wire' }, { qty: 0.5, unit: 'm', name: 'LED strip' }, { qty: 0.5, unit: 'm', name: 'WS2812B strip' },
    { qty: 1.5, unit: 'm', name: '22AWG silicone wire red' }, { qty: 0.3, unit: 'm', name: 'heat shrink 3mm' }, { qty: 20, unit: 'g', name: 'Solder' },
    { qty: 30, unit: 'g', name: 'solder' }, { qty: 500, unit: 'g', name: 'solder' }, { qty: 1, unit: 'm', name: 'LED strip' },
    { qty: 0.8, unit: 'm', name: 'heat shrink tubing 3mm' }, { qty: 0.5, unit: 'm', name: 'heat shrink' }, { qty: 10, unit: 'ft', name: 'wire' },
    { qty: 3, unit: 'm', name: 'wire' },
  ]);
  // a size in millimetres is the part's, as is any other number with letters after it
  assert.deepEqual(parseBom('5mm red LEDs\n3mm LED x10\nHeat shrink tubing 3mm\nKapton tape 10mm\n0.96in OLED x2\nSIM7600 4G\nWS2812B LED strip 60/m\nPerfboard 5x7cm'), [
    { qty: 1, name: '5mm red LEDs' }, { qty: 10, name: '3mm LED' }, { qty: 1, name: 'Heat shrink tubing 3mm' }, { qty: 1, name: 'Kapton tape 10mm' },
    { qty: 2, name: '0.96in OLED' }, { qty: 1, name: 'SIM7600 4G' }, { qty: 1, name: 'WS2812B LED strip 60/m' }, { qty: 1, name: 'Perfboard 5x7cm' },
  ]);
  // a range is the most it could need
  assert.deepEqual(parseBom('4-6 M3x8 screws\n2–3x NeoPixel Jewel\n3-4 pin JST'), [{ qty: 6, name: 'M3x8 screws' }, { qty: 3, name: 'NeoPixel Jewel' }, { qty: 1, name: '3-4 pin JST' }]);
  reads('2m of wire', 2, ['wire', 'jump'], false);
  reads('WS2812B strip 0.5m', 0.5, ['stripa', 'stripb'], false);
  reads('0.8 m heat shrink tubing 3mm', 0.8, 'heat');
  reads('1.5m 22AWG silicone wire red', 1.5, 'wire');
  reads('4-6 M3x8 screws', 6, ['m3x8', 'm3x8pan']);
  reads('Solder 20g', 20, 'solder', false);
});

test('a line in another unit of the same kind is counted in its part’s', () => {
  const heat = { id: 'heat', name: 'Heat shrink tubing 3mm', qty: 1, unit: 'm' }, solder = { id: 's', name: 'Solder', qty: 250, unit: 'g' }, bme = { id: 'b', name: 'BME280', qty: 5, unit: 'pcs' };
  assert.equal(inPartUnit({ qty: 0.3, unit: 'm', m: { p: heat } }), 0.3);
  assert.equal(inPartUnit({ qty: 10, unit: 'ft', m: { p: heat } }), 3.048);
  assert.equal(inPartUnit({ qty: 0.3, m: { p: heat } }), 0.3, 'no unit: the part’s');
  assert.equal(inPartUnit({ qty: 2, unit: 'm', m: { p: bme } }), 2, 'a part in pieces: as written');
  assert.equal(inPartUnit({ qty: 0.5, unit: 'm', m: { p: { ...heat, unit: 'cm' } } }), 50);
  assert.equal(inPartUnit({ qty: 20, unit: 'g', m: { p: { ...solder, unit: 'kg' } } }), 0.02);
  assert.equal(unitOf({ qty: 0.3, m: { p: heat } }), 'm');
  assert.equal(unitOf({ qty: 10, unit: 'ft', m: { p: heat } }), 'm');
  assert.equal(unitOf({ qty: 2, unit: 'm', m: { p: bme } }), 'm');
  assert.equal(unitOf({ qty: 2, m: { p: bme } }), '');
  assert.equal(unitOf({ qty: 2, unit: 'm', m: null }), 'm');
  const n = needs([{ qty: 0.5, unit: 'm', m: { p: heat } }, { qty: 30, unit: 'cm', m: { p: heat } }, { qty: 2, unit: 'ft', m: { p: heat } }]);
  assert.deepEqual(n.get('heat'), { qty: 1.41, lines: 3 });
});

test('a heading in a pasted list is read as one, not as a part', () => {
  // from the Adafruit headlight guide, an Instructables list, a forum post and a Fritzing export
  assert.deepEqual(parseBom('Hardware Supplies\nSupplies\nFor this build you\'ll need:\nShopping List\nParts list:\nElectronics\nTools and supplies\nWhat you need'), [
    { qty: 1, name: 'Hardware Supplies', heading: true }, { qty: 1, name: 'Supplies', heading: true }, { qty: 1, name: 'For this build you\'ll need', heading: true },
    { qty: 1, name: 'Shopping List', heading: true }, { qty: 1, name: 'Parts list', heading: true }, { qty: 1, name: 'Electronics', heading: true },
    { qty: 1, name: 'Tools and supplies', heading: true }, { qty: 1, name: 'What you need', heading: true },
  ]);
  // a line with a count, or with a word no heading has, is a part
  assert.deepEqual(parseBom('2 Hardware Supplies\nM3 hardware kit\nParts bin labels\nTools x2'), [
    { qty: 2, name: 'Hardware Supplies' }, { qty: 1, name: 'M3 hardware kit' }, { qty: 1, name: 'Parts bin labels' }, { qty: 2, name: 'Tools' },
  ]);
});
