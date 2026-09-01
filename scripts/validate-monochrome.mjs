import assert from 'node:assert/strict';
import {
  applyXpsMonochromeXml,
  createMonochromePage,
  monochromeColorWithAlpha,
  normalizeMonochromeColor
} from '../dist/render/monochrome.js';

assert.equal(normalizeMonochromeColor('#000'), 'rgb(0, 0, 0)');
assert.equal(normalizeMonochromeColor('not-a-color'), undefined);
assert.equal(monochromeColorWithAlpha('#000000', '#80ff0000'), 'rgba(0, 0, 0, 0.501961)');

const w2d = {
  id: 'page-1',
  name: 'Sheet 1',
  kind: 'w2d-text',
  sourcePath: 'sheet.w2d',
  width: 100,
  height: 100,
  diagnostics: [],
  primitives: [
    { type: 'polyline', points: [0, 0, 10, 10] },
    { type: 'polygon', points: [0, 0, 10, 0, 10, 10], fill: '#4000ff00' },
    { type: 'text', x: 1, y: 2, text: 'A', size: 12 },
    { type: 'path', commands: [], stroke: 'Transparent' }
  ]
};
const w2dMono = createMonochromePage(w2d, '#000000');
assert.notEqual(w2dMono, w2d);
assert.equal(w2d.primitives[0].stroke, undefined, 'source page must not be mutated');
assert.equal(w2dMono.primitives[0].stroke, 'rgb(0, 0, 0)');
assert.equal(w2dMono.primitives[1].fill, 'rgba(0, 0, 0, 0.25098)');
assert.equal(w2dMono.primitives[1].stroke, undefined, 'monochrome must not add polygon outlines');
assert.equal(w2dMono.primitives[2].fill, 'rgb(0, 0, 0)');
assert.equal(w2dMono.primitives[3].stroke, 'rgba(0, 0, 0, 0)');
assert.equal(createMonochromePage(w2d, '#000000'), w2dMono, 'transformed pages should be cached');

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const indices = new Uint16Array([0, 1, 2]);
const w3d = {
  id: 'page-2',
  name: 'Model',
  kind: 'w3d-model',
  sourcePath: 'model.w3d',
  width: 100,
  height: 100,
  diagnostics: [],
  model: {
    kind: 'w3d-model',
    title: 'Model',
    meshes: [{
      id: 'mesh-1',
      name: 'Mesh',
      positions,
      indices,
      vertexCount: 3,
      triangleCount: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      color: [1, 0, 0],
      sourceStart: 0,
      sourceEnd: 1,
      decodeKind: 'uncompressed'
    }],
    materials: [{ id: 'material-1', color: [1, 0, 0], opacity: 0.35 }],
    bounds: { min: [0, 0, 0], max: [1, 1, 0], center: [0.5, 0.5, 0], radius: 1 },
    stats: { meshCount: 1, vertexCount: 3, triangleCount: 1, decodedBytes: positions.byteLength },
    diagnostics: []
  }
};
const w3dMono = createMonochromePage(w3d, '#ffffff');
assert.deepEqual(w3dMono.model.meshes[0].color, [1, 1, 1]);
assert.equal(w3dMono.model.meshes[0].positions, positions, 'geometry buffers must be shared');
assert.equal(w3dMono.model.materials[0].opacity, 0.35, 'material opacity must be preserved');
assert.deepEqual(w3d.model.meshes[0].color, [1, 0, 0], 'source model must not be mutated');

const xps = '<FixedPage><Path Fill="#80FF0000" Stroke="{StaticResource Pen}" Opacity="0.4"/><SolidColorBrush x:Key="Pen" Color="#FF00FF00"/><GradientStop Color="sc#0.25,1,0,0"/><ImageBrush ImageSource="Resources/image.png"/></FixedPage>';
const xpsMono = applyXpsMonochromeXml(xps, '#000000');
assert.match(xpsMono, /Fill="rgba\(0, 0, 0, 0\.501961\)"/);
assert.match(xpsMono, /Stroke="\{StaticResource Pen\}"/);
assert.match(xpsMono, /Color="rgb\(0, 0, 0\)"/);
assert.match(xpsMono, /Color="rgba\(0, 0, 0, 0\.25\)"/);
assert.match(xpsMono, /Opacity="0\.4"/);
assert.match(xpsMono, /ImageSource="Resources\/image\.png"/);

console.log('Monochrome color validation passed.');
