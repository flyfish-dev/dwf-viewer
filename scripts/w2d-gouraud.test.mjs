import assert from 'node:assert/strict';
import test from 'node:test';
import { parseW2dBinary } from '../dist/format/w2dBinary.js';
import { rasterizeGouraudTriangle } from '../dist/render/gouraud.js';
import { W2dRenderer } from '../dist/render/W2dRenderer.js';
import { createMonochromePage } from '../dist/render/monochrome.js';
import { createContrastPage } from '../dist/render/contrast.js';

const header = Buffer.from('(W2D V06.00)');
const red = [255, 0, 0, 255];
const green = [0, 255, 0, 255];
const blue = [0, 0, 255, 255];

function gouraud(points, colors, bits = 16) {
  const count = points.length;
  const countBytes = count < 256 ? Buffer.from([count]) : Buffer.from([0, (count - 256) & 255, (count - 256) >>> 8]);
  const body = Buffer.alloc(count * (bits === 16 ? 8 : 12));
  let offset = 0;
  for (let i = 0; i < count; i++) {
    for (const component of points[i]) {
      if (bits === 16) body.writeInt16LE(component, offset);
      else body.writeInt32LE(component, offset);
      offset += bits / 8;
    }
    for (const channel of colors[i]) body[offset++] = channel;
  }
  return Buffer.concat([Buffer.from([bits === 16 ? 0x07 : 0x67]), countBytes, body]);
}

function parse(...parts) {
  return parseW2dBinary(Buffer.concat([header, ...parts]), 'gouraud.w2d');
}

test('issue #2 byte sequence decodes both triangles and resumes at the next opcode', () => {
  // First two complete Gouraud records from the public issue's hex dump.
  const bytes = Buffer.from('0703eff63411d8d8a6b20b00abffd8d8a6b26dfd0000d8d8a6b207030700c5ffd8d8a6b294020000d8d8a6b278fdabffd8d8a6b2', 'hex');
  const result = parse(Buffer.from('F'), bytes, Buffer.from('L 0,0 100,100 (EndOfDWF)'));
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.equal(result.primitives.length, 3);
  assert.deepEqual(result.primitives[0].points, [-2321, 4404, -2310, 4319, -2969, 4319]);
  assert.equal(result.primitives[0].fill, 'rgba(216, 216, 166, 0.6980392156862745)');
  assert.equal(result.primitives[0].vertexColors, undefined);
  assert.deepEqual(result.primitives[2].points, [0, 0, 100, 100]);
});

test('Gouraud triangle strips retain per-vertex colors without changing current stroke', () => {
  const bytes = gouraud([[1, 2], [10, 0], [-10, 10], [10, 0]], [red, green, blue, red]);
  const tail = Buffer.from([0x0c, 1, 0, 2, 0, 3, 0, 4, 0]);
  const result = parse(bytes, tail);
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.equal(result.primitives.length, 3);
  assert.deepEqual(result.primitives[0].points, [1, 2, 11, 2, 1, 12]);
  assert.deepEqual(result.primitives[1].points, [11, 2, 1, 12, 11, 12]);
  assert.deepEqual(result.primitives[0].vertexColors, ['rgba(255, 0, 0, 1)', 'rgba(0, 255, 0, 1)', 'rgba(0, 0, 255, 1)']);
  assert.deepEqual(result.primitives[2].points, [12, 14, 15, 18]);
  assert.equal(result.primitives[2].stroke, '#000000');
});

test('32-bit relative Gouraud opcode preserves coordinates beyond int16', () => {
  const result = parse(gouraud([[70000, -80000], [90000, 0], [-90000, 100000]], [red, green, blue], 32));
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.deepEqual(result.primitives[0].points, [70000, -80000, 160000, -80000, 70000, 20000]);
});

test('extended point count consumes 256 vertices and preserves the following record', () => {
  const points = Array.from({ length: 256 }, (_, index) => [index % 2, 1]);
  const result = parse(gouraud(points, points.map(() => red)), Buffer.from('L 1,2 3,4'));
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.equal(result.primitives.length, 255);
  assert.deepEqual(result.primitives.at(-1).points, [1, 2, 3, 4]);
});

test('invisible Gouraud geometry still advances the relative-point origin', () => {
  const result = parse(Buffer.from('v'), gouraud([[1, 2], [10, 0], [-10, 10]], [red, green, blue]), Buffer.from([0x56, 0x0c, 1, 0, 2, 0, 3, 0, 4, 0]));
  assert.deepEqual(result.unsupportedOpcodes, []);
  assert.equal(result.primitives.length, 1);
  assert.deepEqual(result.primitives[0].points, [2, 14, 5, 18]);
});

test('truncated Gouraud operands stop with a diagnostic and emit no fabricated triangles', () => {
  const bytes = gouraud([[0, 0], [10, 0], [-10, 10]], [red, green, blue]);
  for (const end of [1, 2, 6, bytes.length - 1]) {
    const result = parse(bytes.subarray(0, end));
    assert.equal(result.primitives.length, 0);
    assert.equal(result.unsupportedOpcodes.length, 1);
    assert.equal(result.unsupportedOpcodes[0].offset, header.length);
    assert.equal(result.unsupportedOpcodes[0].opcode, 7);
  }
});

test('Canvas Gouraud fallback interpolates colors and alpha and clips allocations to viewport', () => {
  const raster = rasterizeGouraudTriangle([0, 0, 10, 0, 0, 10], ['#ff0000', '#00ff00', '#0000ff'], 4, 4);
  assert.equal(raster.width, 4);
  assert.equal(raster.height, 4);
  const center = Array.from(raster.data.subarray((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 4));
  assert.deepEqual(center, [128, 64, 64, 255]);
  const translucent = rasterizeGouraudTriangle([0, 0, 10, 0, 0, 10], ['rgba(255,0,0,0.5)', 'rgba(0,255,0,0.5)', 'rgba(0,0,255,0.5)'], 4, 4);
  assert.equal(translucent.data[(2 * 4 + 2) * 4 + 3], 128);
  assert.equal(rasterizeGouraudTriangle([0, 0, 1, 1, 2, 2], ['red', 'green', 'blue'], 4, 4), undefined);
});

test('adjacent translucent triangles composite once at their shared diagonal, in either winding', () => {
  const colors = ['rgba(255,0,0,0.5)', 'rgba(0,255,0,0.5)', 'rgba(0,0,255,0.5)'];
  for (const reverse of [false, true]) {
    const triangles = [[0,0,4,0,0,4], [4,0,4,4,0,4]].map(p=>reverse ? [p[0],p[1],p[4],p[5],p[2],p[3]] : p);
    const rasters = triangles.map(p=>rasterizeGouraudTriangle(p,colors,4,4));
    for (let i=0;i<16;i++) {
      const a=rasters[0].data[i*4+3],b=rasters[1].data[i*4+3];
      const composited=b+a*(1-b/255);
      assert.equal(composited,128,`pixel ${i%4},${Math.floor(i/4)}, winding ${reverse}`);
      assert.equal(Number(a>0)+Number(b>0),1);
    }
  }
});

test('Canvas Gouraud work is bounded per triangle and per frame before painting', async () => {
  assert.throws(()=>rasterizeGouraudTriangle([0,0,5000,0,0,5000],['red','green','blue'],5000,5000),/pixel budget/);
  const primitive={type:'polygon',points:[0,0,100,0,0,100],vertexColors:['red','green','blue']};
  const page={id:'budget',kind:'w2d-text',sourcePath:'budget.w2d',width:100,height:100,bounds:{minX:0,minY:0,maxX:100,maxY:100},diagnostics:[],primitives:Array.from({length:200},()=>primitive)};
  let paints=0;
  const canvas={width:1024,height:1024,style:{},getContext:()=>({save(){paints++;}})};
  await assert.rejects(()=>new W2dRenderer().render(page,canvas,{preferWebgl:false}),/frame pixel budget/);
  assert.equal(paints,0);
});

test('Canvas keeps a polygon stroke after painting vertex colors', () => {
  let strokes=0,flatFills=0,images=0;
  const buffer={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}};
  const canvas={width:40,height:40,ownerDocument:{createElement:()=>({getContext:()=>buffer})}};
  const ctx={canvas,save(){},restore(){},setTransform(){},drawImage(){images++;},beginPath(){},moveTo(){},lineTo(){},closePath(){},stroke(){strokes++;},fill(){flatFills++;}};
  const p={type:'polygon',points:[0,0,10,0,0,10],vertexColors:['red','green','blue'],fill:'red',stroke:'black'};
  new W2dRenderer().drawPrimitiveCanvas(ctx,p,{a:1,b:0,c:0,d:1,e:0,f:0},{},{dpr:1,zoom:1});
  assert.equal(images,1);assert.equal(strokes,1);assert.equal(flatFills,0);
});

test('monochrome and contrast policies preserve gradient alpha and transform all vertex colors', () => {
  const page = { kind: 'w2d-text', id: 'p', sourcePath: 'test.w2d', primitives: [{ type: 'polygon', points: [0, 0, 10, 0, 0, 10], vertexColors: ['rgba(255, 0, 0, 0.5)', 'rgba(0, 255, 0, 0.5)', 'rgba(0, 0, 255, 0.5)'], fill: 'rgba(255, 0, 0, 0.5)' }], diagnostics: [] };
  const mono = createMonochromePage(page, '#ffffff');
  assert.equal(new Set(mono.primitives[0].vertexColors).size, 1);
  assert.equal(mono.primitives[0].vertexColors[0], 'rgba(255, 255, 255, 0.5)');
  assert.notEqual(mono.primitives[0].vertexColors[0], page.primitives[0].vertexColors[0]);
  const contrast = createContrastPage(page, { contrastMode: 'adaptive', background: '#000000' });
  assert.equal(contrast.primitives[0].vertexColors.length, 3);
  assert.deepEqual(page.primitives[0].vertexColors, ['rgba(255, 0, 0, 0.5)', 'rgba(0, 255, 0, 0.5)', 'rgba(0, 0, 255, 0.5)']);
});
