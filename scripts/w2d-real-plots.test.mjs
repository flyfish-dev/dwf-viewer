import assert from 'node:assert/strict';
import test from 'node:test';
import { parseW2dBinary } from '../dist/format/w2dBinary.js';
import { W2dRenderer } from '../dist/render/W2dRenderer.js';

// Records found in AutoCAD-plotted DWF 6 sheets. Before these fixes the parser stopped at the first of them, and
// everything after it was missing from the page.
const header = Buffer.from('(W2D V06.00)');
const i16 = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((n, i) => b.writeInt16LE(n, i * 2)); return b; };
const i32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((n, i) => b.writeInt32LE(n, i * 4)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const line16 = Buffer.concat([Buffer.from([0x0c]), i16(1, 2, 3, 4)]);
const parse = (...parts) => parseW2dBinary(Buffer.concat([header, ...parts, Buffer.from('(EndOfDWF)')]), 'plot.w2d');

test('an extended binary object is skipped by its size, which counts the opcode and the closing brace', () => {
  // '{', size = 2 (opcode) + 3 (payload) + 1 ('}'), opcode 0x0020, payload, '}', then a line.
  const ext = Buffer.concat([Buffer.from('{'), u32(6), u16(0x0020), Buffer.from([1, 2, 3]), Buffer.from('}')]);
  const result = parse(ext, line16);
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.equal(result.primitives.length, 1);
  assert.deepEqual(result.primitives[0].points, [1, 2, 4, 6]);
});

test('contour sets (0x0b, k) are one even-odd filled path per set, holes included', () => {
  const k16 = Buffer.concat([Buffer.from([0x0b, 2, 4, 3]), i16(0, 0, 10, 0, 0, 10, -10, 0), i16(2, -8, 4, 0, 0, 4)]);
  const k32 = Buffer.concat([Buffer.from([0x6b, 1, 3]), i32(100000, 0, 10, 0, 0, 10)]);
  const result = parse(Buffer.from('F'), k16, k32, line16);
  assert.deepEqual(result.unsupportedOpcodes, []);
  const [square, tri] = result.primitives;
  assert.equal(square.type, 'path');
  assert.equal(square.fillRule, 'evenodd');
  assert.deepEqual(square.commands.map(c => c.type).join(''), 'MLLLZMLLZ');
  assert.deepEqual(square.commands.slice(5, 8).map(c => [c.x, c.y]), [[2, 2], [6, 2], [6, 6]]);
  assert.deepEqual(tri.commands[0], { type: 'M', x: 100006, y: 6 }); // relative to the hole's last point (6,6)
  assert.equal(result.primitives[2].type, 'polyline');
});

test('Gouraud polylines (0x11, q) become segments in their vertex colours', () => {
  const q16 = Buffer.concat([Buffer.from([0x11, 3]), i16(0, 0), Buffer.from([255, 0, 0, 255]), i16(10, 0), Buffer.from([0, 255, 0, 255]), i16(0, 10), Buffer.from([0, 0, 255, 255])]);
  const q32 = Buffer.concat([Buffer.from([0x71, 2]), i32(5, 5), Buffer.from([1, 2, 3, 255]), i32(5, 5), Buffer.from([4, 5, 6, 255])]);
  const result = parse(q16, q32, line16);
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.deepEqual(result.primitives.slice(0, 3).map(p => [p.type, p.stroke, p.points]), [
    ['polyline', 'rgba(255, 0, 0, 1)', [0, 0, 10, 0]],
    ['polyline', 'rgba(0, 255, 0, 1)', [10, 0, 10, 10]],
    ['polyline', 'rgba(1, 2, 3, 1)', [15, 15, 20, 20]],
  ]);
});

test('object nodes (0x0e) and symbol records (0x8d, m, M, G, S, s) are read, and placements are reported', () => {
  const records = Buffer.concat([
    Buffer.from([0x0e]),
    Buffer.from([0x8d, 2]), i16(1, 1, 2, 2),
    Buffer.from([0x6d, 1]), i32(3, 3),
    Buffer.from('M 1 7,7 G 4'),
  ]);
  const result = parse(records, line16);
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.equal(result.primitives.length, 1);
  const note = result.diagnostics.find(d => d.code === 'W2D_MACRO_NOT_DRAWN');
  assert.equal(note.level, 'info'); // V06.00 markers at the default size 0 are single pixels; no symbol is defined
  assert.match(note.message, /^4 visible symbol placement\(s\), 0 with a marker size; 0 symbol definition/);
  // Relative placements advance the current point (1,1), (3,3), (6,6); the ASCII one is absolute and does not.
  assert.deepEqual(result.primitives[0].points, [7, 8, 10, 12]);
});

test('symbol placements are a warning only when something visible is lost', () => {
  const level = (version, ...parts) => parseW2dBinary(Buffer.concat([Buffer.from(`(W2D V${version})`), ...parts, Buffer.from('(EndOfDWF)')]), 'm.w2d')
    .diagnostics.find(d => d.code === 'W2D_MACRO_NOT_DRAWN')?.level;
  const place = Buffer.concat([Buffer.from([0x8d, 1]), i16(5, 5)]);
  assert.equal(level('06.00', Buffer.from('S 100'), place), 'warning'); // a sized built-in marker before 6.01
  assert.equal(level('06.00', Buffer.concat([Buffer.from([0x73]), i32(40)]), place), 'warning');
  assert.equal(level('06.00', Buffer.from('S 100v'), place, Buffer.from('V')), undefined); // hidden: nothing counted
  assert.equal(level('06.01', Buffer.from('S 100'), place), 'info'); // a macro scale, and no macro defined
  assert.equal(level('06.01', Buffer.from('(Macro 1 100 (L 0,0 10,10))'), place), 'warning');
  assert.equal(level('06.00', Buffer.from('(Glyph 1 0,0 10 (L 0,0 10,10))'), place), 'warning');
});

test('flatGouraud fills a colour-shaded triangle with its average colour, without a raster canvas', () => {
  const fills = [];
  let images = 0;
  const ctx = { canvas: { width: 40, height: 40 }, fillStyle: '', save() {}, restore() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, drawImage() { images++; }, fill() { fills.push(this.fillStyle); }, stroke() {} };
  const p = { type: 'polygon', points: [0, 0, 10, 0, 0, 10], vertexColors: ['rgba(255, 0, 0, 1)', 'rgba(0, 255, 0, 1)', 'rgba(0, 0, 255, 0.5)'] };
  new W2dRenderer().drawPrimitiveCanvas(ctx, p, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, { flatGouraud: true }, { dpr: 1, zoom: 1 });
  assert.equal(images, 0);
  assert.deepEqual(fills, ['rgba(85, 85, 85, 0.8333333333333334)']);
});

test('a path may ask for the even-odd fill rule', () => {
  const rules = [];
  const ctx = { canvas: { width: 40, height: 40 }, save() {}, restore() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill(rule) { rules.push(rule); }, stroke() {} };
  const p = { type: 'path', commands: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'L', x: 0, y: 10 }, { type: 'Z' }], fill: '#000000', fillRule: 'evenodd' };
  new W2dRenderer().drawPrimitiveCanvas(ctx, p, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, {}, { dpr: 1, zoom: 1 });
  new W2dRenderer().drawPrimitiveCanvas(ctx, { ...p, fillRule: undefined }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, {}, { dpr: 1, zoom: 1 });
  assert.deepEqual(rules, ['evenodd', 'nonzero']);
});
