import { readFile } from 'fs/promises';
import { openDwfDocument } from '../dist/index.js';

const targets = [
  { label: 'Autodesk Floor Plans DWFx A03', path: 'examples/autodesk-floor-plans.dwfx', pageIndex: 3, kind: 'xps-fixed-page', minPages: 18, maxNonInfoDiagnostics: 0 },
  { label: 'Robot Arm 3D DWFx', path: 'examples/robot-arm.dwfx', kind: 'w3d-model', minMeshes: 30, minTriangles: 40000, minDistinctMeshColors: 24, maxNonInfoDiagnostics: 0, maxPageDiagnostics: 0 },
  { label: '2D sample DWFx', path: 'examples/minimal-xps.dwfx', kind: 'xps-fixed-page' },
  { label: 'official binary W2D DWF', path: 'examples/blocks-and-tables.dwf', kind: 'w2d-text' },
  {
    label: 'AutoCAD R14 legacy ASCII DWF V00.34',
    path: 'examples/legacy-ascii-v0034.dwf',
    kind: 'w2d-text',
    expectedPrimitives: 8,
    expectedPrimitiveTypes: { polyline: 3, polygon: 3, rect: 2 },
    expectedBackdrop: 'rgb(0, 0, 0)',
    maxNonInfoDiagnostics: 0
  }
];

let failed = false;
for (const t of targets) {
  const doc = await openDwfDocument(await readFile(t.path), { fileName: t.path });
  const page = doc.pageData[t.pageIndex ?? 0];
  const nonInfo = (page?.diagnostics ?? []).filter(d => d.level !== 'info');
  const primitiveTypes = page?.kind === 'w2d-text' ? countPrimitiveTypes(page.primitives) : undefined;
  const backdrop = page?.kind === 'w2d-text' && page.primitives[0]?.type === 'rect' ? page.primitives[0].fill : undefined;
  const record = {
    label: t.label,
    documentKind: doc.kind,
    pages: doc.pageData.length,
    pageIndex: t.pageIndex ?? 0,
    pageKind: page?.kind,
    pageName: page?.name,
    primitives: page?.kind === 'w2d-text' ? page.primitives.length : undefined,
    primitiveTypes,
    backdrop,
    meshes: page?.kind === 'w3d-model' ? page.model.meshes.length : undefined,
    triangles: page?.kind === 'w3d-model' ? page.model.stats.triangleCount : undefined,
    distinctMeshColors: page?.kind === 'w3d-model' ? distinctMeshColors(page) : undefined,
    nonInfoDiagnostics: nonInfo.length,
    diagnostics: nonInfo
  };
  console.log(JSON.stringify(record, null, 2));
  if (!page || page.kind !== t.kind) failed = true;
  if (typeof t.minPages === 'number' && doc.pageData.length < t.minPages) failed = true;
  if (typeof t.minMeshes === 'number' && (!(page?.kind === 'w3d-model') || page.model.meshes.length < t.minMeshes)) failed = true;
  if (typeof t.minTriangles === 'number' && (!(page?.kind === 'w3d-model') || page.model.stats.triangleCount < t.minTriangles)) failed = true;
  if (typeof t.minDistinctMeshColors === 'number' && (!(page?.kind === 'w3d-model') || distinctMeshColors(page) < t.minDistinctMeshColors)) failed = true;
  if (typeof t.expectedPrimitives === 'number' && (!(page?.kind === 'w2d-text') || page.primitives.length !== t.expectedPrimitives)) failed = true;
  if (t.expectedPrimitiveTypes) {
    if (!(page?.kind === 'w2d-text')) {
      failed = true;
    } else {
      const actual = countPrimitiveTypes(page.primitives);
      for (const [type, count] of Object.entries(t.expectedPrimitiveTypes)) {
        if ((actual[type] ?? 0) !== count) failed = true;
      }
    }
  }
  if (typeof t.expectedBackdrop === 'string' && backdrop !== t.expectedBackdrop) failed = true;
  if (typeof t.maxNonInfoDiagnostics === 'number' && nonInfo.length > t.maxNonInfoDiagnostics) failed = true;
  if (typeof t.maxPageDiagnostics === 'number' && (page?.diagnostics?.length ?? 0) > t.maxPageDiagnostics) failed = true;
}

// Browser compatibility regression: some DWFx eModel content-definition XML uses
// invalid legacy namespace declarations such as xmlns:schemaLocation. Strict
// browser DOMParser implementations reject that form, so parseXml must repair
// or fall back without surfacing EMODEL_CONTENTDEF_PARSE_FAILED warnings.
{
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        getElementsByTagName(name) {
          return name === 'parsererror' ? [{ textContent: 'simulated strict namespace parser error' }] : [];
        }
      };
    }
  };

  const { parseXml } = await import('../dist/format/util.js');
  const invalid = '<dwf:SectionContent xmlns:dwf="DWF-ContentResource:1.0" xmlns:schemaLocation="DWF-ContentResource:1.0 http://autodesk.com/global/dwf/sectioncontent.xsd" version="1.0"><dwf:Instances><dwf:Instance id="i1" renderableRef="r1"/></dwf:Instances></dwf:SectionContent>';
  const doc = parseXml(invalid, 'browser-strict-dwf-content.xml');
  const instances = Array.from(doc.getElementsByTagName('*')).filter(e => (e.localName || e.nodeName).replace(/^.*:/, '') === 'Instance');
  if (instances.length !== 1 || instances[0].getAttribute('renderableRef') !== 'r1') {
    failed = true;
    console.error('Browser XML tolerance regression failed.');
  } else {
    console.log(JSON.stringify({ label: 'browser strict XML tolerance', instances: instances.length, diagnostics: [] }, null, 2));
  }

  const strictDoc = await openDwfDocument(await readFile('examples/robot-arm.dwfx'), { fileName: 'examples/robot-arm.dwfx' });
  const strictPage = strictDoc.pageData[0];
  const strictNonInfo = (strictPage?.diagnostics ?? []).filter(d => d.level !== 'info');
  const strictRecord = {
    label: 'Robot Arm under strict browser DOMParser simulation',
    pageKind: strictPage?.kind,
    diagnostics: strictPage?.diagnostics ?? [],
    meshes: strictPage?.kind === 'w3d-model' ? strictPage.model.meshes.length : undefined,
    triangles: strictPage?.kind === 'w3d-model' ? strictPage.model.stats.triangleCount : undefined
  };
  console.log(JSON.stringify(strictRecord, null, 2));
  if (!strictPage || strictPage.kind !== 'w3d-model' || strictNonInfo.length !== 0 || (strictPage.diagnostics?.length ?? 0) !== 0) {
    failed = true;
    console.error('Strict browser DOMParser simulation opened Robot Arm with diagnostics or wrong page kind.');
  }

  if (previous === undefined) delete globalThis.DOMParser;
  else globalThis.DOMParser = previous;
}

if (failed) process.exit(1);

function distinctMeshColors(page) {
  return new Set(page.model.meshes.map(mesh => (mesh.color ?? []).map(v => Number(v).toFixed(4)).join(','))).size;
}

function countPrimitiveTypes(primitives) {
  const counts = {};
  for (const primitive of primitives) counts[primitive.type] = (counts[primitive.type] ?? 0) + 1;
  return counts;
}
