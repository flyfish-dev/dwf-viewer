import { diag } from './types.js';
import { createOpcView } from './opc.js';
import { decodeUtf8, localName, mimeFromPath, parseXml, normalizePath, resolvePart } from './util.js';
import { makeLoadedDocument } from './document.js';
import { parseW3dModel } from './w3d.js';
import { enrichW3dModelFromEModelResources } from './emodelMetadata.js';
const XPS_FIXED_REP_TYPES = new Set([
    'http://schemas.microsoft.com/xps/2005/06/fixedrepresentation',
    'http://schemas.openxps.org/oxps/v1.0/fixedrepresentation'
]);
export async function openDwfx(zip) {
    const opc = await createOpcView(zip);
    const diagnostics = [];
    const pageData = [];
    // DWFx is an OPC package, but many Autodesk-produced DWFx files are not
    // pure XPS documents.  They may contain a DWF manifest with ePlot/eModel
    // sections.  Prefer that manifest when present so synthetic XPS notice pages
    // are not shown as real drawings, and so eModel-only packages can still open
    // with their embedded thumbnail/preview image.
    const manifestSections = await collectDwfxManifestPages(opc, pageData, diagnostics);
    if (pageData.length === 0) {
        const fdseqs = await findFixedDocumentSequences(opc, diagnostics);
        for (const fdseqPath of fdseqs) {
            try {
                const fdseqXml = await opc.readText(fdseqPath);
                const fdseqDoc = parseXml(fdseqXml, fdseqPath);
                const docRefs = Array.from(fdseqDoc.getElementsByTagName('*')).filter(e => localName(e) === 'DocumentReference');
                if (docRefs.length === 0)
                    diagnostics.push(diag('warning', 'DWFX_NO_DOCREF', `No DocumentReference elements found in ${fdseqPath}.`, fdseqPath));
                for (const docRef of docRefs) {
                    const source = docRef.getAttribute('Source');
                    if (!source)
                        continue;
                    const fdocPath = resolvePart(fdseqPath, source);
                    await collectFixedDocumentPages(opc, fdocPath, pageData, diagnostics);
                }
            }
            catch (err) {
                diagnostics.push(diag('warning', 'DWFX_FDSEQ_READ_FAILED', `Failed to read fixed document sequence: ${String(err)}`, fdseqPath));
            }
        }
    }
    if (pageData.length === 0) {
        // DWFx produced by some tools omits the package-level relationship; fall back to extension scan.
        const fpages = zip.entries.filter(e => /\.fpage$/i.test(e.name));
        for (const [index, entry] of fpages.entries()) {
            const size = await readFixedPageSize(opc, entry.name, diagnostics);
            pageData.push({
                id: `page-${index + 1}`,
                name: entry.name.split('/').pop() ?? `Page ${index + 1}`,
                kind: 'xps-fixed-page',
                sourcePath: entry.name,
                width: size.width,
                height: size.height,
                diagnostics: []
            });
        }
    }
    if (pageData.length === 0) {
        const has3d = zip.entries.some(e => /\.(w3d|hsf)$/i.test(e.name)) || manifestSections.some(s => /emodel/i.test(s.type));
        pageData.push({
            id: 'unsupported-1',
            name: has3d ? 'Unsupported 3D DWFx package' : 'Unsupported DWFx package',
            kind: 'unsupported',
            width: 1000,
            height: 1000,
            reason: has3d
                ? 'This DWFx package contains 3D eModel/W3D content but no supported 2D FixedPage or preview image resource was found.'
                : 'No XPS FixedPage parts or supported DWF manifest preview resources were found.',
            diagnostics: [diag('error', 'DWFX_NO_PAGES', 'No supported renderable page was found in this DWFx package.')]
        });
    }
    const base = {
        kind: 'dwfx',
        pages: [],
        resources: opc.resources,
        diagnostics,
        packageEntries: zip.entries.map(e => e.name)
    };
    return makeLoadedDocument(base, pageData, zip, opc);
}
export function isProbablyDwfx(zip) {
    return zip.has('[Content_Types].xml') && (zip.has('_rels/.rels') || zip.entries.some(e => /\.(fpage|dwfseq)$/i.test(e.name)));
}
async function collectDwfxManifestPages(opc, pageData, diagnostics) {
    const manifestPaths = await findDwfManifestPaths(opc, diagnostics);
    const allSections = [];
    for (const manifestPath of manifestPaths) {
        try {
            const xml = await opc.readText(manifestPath);
            const sections = parseDwfManifestSections(xml, manifestPath);
            allSections.push(...sections);
            diagnostics.push(diag('info', 'DWFX_DWF_MANIFEST_FOUND', `Found DWFx DWF manifest with ${sections.length} section(s).`, manifestPath));
        }
        catch (err) {
            diagnostics.push(diag('warning', 'DWFX_DWF_MANIFEST_PARSE_FAILED', `Failed to parse DWFx DWF manifest: ${String(err)}`, manifestPath));
        }
    }
    // First create real 2D drawing pages.  Do not include eModel thumbnails when
    // ePlot pages are available; otherwise the first page can become a 3D preview
    // instead of the first sheet.
    for (const section of allSections.filter(s => isEPlotSection(s))) {
        const fixedPage = resourceByRole(section, /2d\s+streaming\s+graphics/i)
            ?? section.resources.find(r => /\.fpage$/i.test(r.path));
        if (!fixedPage || !/\.fpage$/i.test(stripQuery(fixedPage.path)))
            continue;
        const pagePath = stripQuery(fixedPage.path);
        if (!opc.zip.has(pagePath))
            continue;
        const size = await readFixedPageSize(opc, pagePath, diagnostics);
        pageData.push({
            id: `page-${pageData.length + 1}`,
            name: section.title || fixedPage.title || basename(pagePath),
            kind: 'xps-fixed-page',
            sourcePath: pagePath,
            width: Number.isFinite(size.width) && size.width > 0 ? size.width : 1000,
            height: Number.isFinite(size.height) && size.height > 0 ? size.height : 1000,
            diagnostics: []
        });
    }
    if (pageData.length > 0)
        return allSections;
    // eModel-only DWFx packages carry W3D/HSF geometry plus optional thumbnails.
    // Production policy: when a W3D/HSF resource is present, treat that resource as
    // authoritative.  Do not silently fall back to a thumbnail if decoding fails;
    // otherwise a real 3D model can be mistaken for a 2D image preview.
    for (const section of allSections.filter(s => isEModelSection(s))) {
        const preview = chooseSectionPreviewResource(section, opc.zip);
        const w3d = resourceByRole(section, /3d\s+streaming\s+graphics/i) ?? section.resources.find(r => /\.(w3d|hsf)$/i.test(r.path));
        if (w3d && opc.zip.has(w3d.path)) {
            try {
                const model = await parseW3dModel(await opc.zip.read(w3d.path), { title: section.title || w3d.title || basename(w3d.path), sourcePath: w3d.path });
                await enrichW3dModelFromEModelResources(model, section.resources, opc);
                if (model.meshes.length > 0) {
                    pageData.push({
                        id: `w3d-${pageData.length + 1}`,
                        name: section.title || w3d.title || basename(w3d.path),
                        kind: 'w3d-model',
                        sourcePath: w3d.path,
                        width: 1000,
                        height: 1000,
                        model,
                        diagnostics: model.diagnostics
                    });
                    continue;
                }
                pageData.push({
                    id: `unsupported-3d-${pageData.length + 1}`,
                    name: section.title || 'Unsupported 3D eModel',
                    kind: 'unsupported',
                    width: 1000,
                    height: 1000,
                    sourcePath: w3d.path,
                    reason: 'A W3D/HSF 3D stream exists, but no renderable shell geometry was decoded.  The package is intentionally not shown as a thumbnail so this failure is visible during production validation.',
                    diagnostics: [
                        ...model.diagnostics,
                        diag('warning', 'DWFX_3D_W3D_UNSUPPORTED', 'Detected a 3D W3D resource, but no renderable shell geometry was decoded.', w3d.path)
                    ]
                });
                continue;
            }
            catch (err) {
                pageData.push({
                    id: `unsupported-3d-${pageData.length + 1}`,
                    name: section.title || 'Unsupported 3D eModel',
                    kind: 'unsupported',
                    width: 1000,
                    height: 1000,
                    sourcePath: w3d.path,
                    reason: `A W3D/HSF 3D stream exists, but geometry parsing failed: ${String(err)}`,
                    diagnostics: [diag('warning', 'DWFX_W3D_PARSE_FAILED', `Failed to parse W3D geometry: ${String(err)}`, w3d.path)]
                });
                continue;
            }
        }
        // Only eModel sections without a W3D/HSF geometry stream may be represented
        // by their thumbnail/preview image.
        if (preview && opc.zip.has(preview.path)) {
            const bytes = await opc.zip.read(preview.path);
            const size = imageSizeFromBytes(bytes) ?? { width: 1000, height: 1000 };
            pageData.push({
                id: `image-${pageData.length + 1}`,
                name: section.title || preview.title || basename(preview.path),
                kind: 'image',
                sourcePath: preview.path,
                mediaType: preview.mediaType ?? mimeFromPath(preview.path) ?? 'image/png',
                width: size.width,
                height: size.height,
                diagnostics: [
                    diag('info', 'DWFX_3D_PREVIEW_ONLY', 'No W3D/HSF geometry stream was declared; showing the embedded section preview image.', preview.path)
                ]
            });
        }
    }
    return allSections;
}
async function findDwfManifestPaths(opc, diagnostics) {
    const out = new Set();
    const add = (p) => { if (p)
        out.add(normalizePath(stripQuery(p))); };
    // Package root relationship -> DWFDocumentSequence.dwfseq -> ManifestReference.
    const dwfseqs = new Set();
    try {
        const rootRels = await opc.getRelationships('');
        for (const rel of rootRels) {
            if (/documentsequence/i.test(rel.type) || /\.dwfseq$/i.test(rel.resolvedTarget))
                dwfseqs.add(normalizePath(rel.resolvedTarget));
            if (/document$/i.test(rel.type) && /manifest\.xml$/i.test(rel.resolvedTarget))
                add(rel.resolvedTarget);
        }
    }
    catch (err) {
        diagnostics.push(diag('warning', 'DWFX_DWFSEQ_RELS_FAILED', `Failed to inspect DWFx package relationships: ${String(err)}`));
    }
    for (const e of opc.zip.entries)
        if (/\.dwfseq$/i.test(e.name))
            dwfseqs.add(e.name);
    for (const dwfseqPath of dwfseqs) {
        if (!opc.zip.has(dwfseqPath))
            continue;
        try {
            const xml = await opc.readText(dwfseqPath);
            const doc = parseXml(xml, dwfseqPath);
            const refs = Array.from(doc.getElementsByTagName('*')).filter(e => localName(e) === 'ManifestReference');
            for (const ref of refs)
                add(ref.getAttribute('Source') ?? ref.getAttribute('source') ?? undefined);
            const rels = await opc.getRelationships(dwfseqPath).catch(() => []);
            for (const rel of rels)
                if (/document/i.test(rel.type) || /manifest\.xml$/i.test(rel.resolvedTarget))
                    add(rel.resolvedTarget);
        }
        catch (err) {
            diagnostics.push(diag('warning', 'DWFX_DWFSEQ_READ_FAILED', `Failed to read DWFDocumentSequence ${dwfseqPath}: ${String(err)}`, dwfseqPath));
        }
    }
    // Last-resort scan.  Limit to DWF manifests under /dwf/documents to avoid
    // treating unrelated XML as a manifest.
    for (const e of opc.zip.entries) {
        if (/^dwf\/documents\/.*\/manifest\.xml$/i.test(e.name))
            add(e.name);
    }
    return Array.from(out).filter(p => opc.zip.has(p));
}
async function findFixedDocumentSequences(opc, diagnostics) {
    const out = new Set();
    try {
        const rootRels = await opc.getRelationships('');
        for (const rel of rootRels) {
            if (XPS_FIXED_REP_TYPES.has(rel.type) || /fixedrepresentation/i.test(rel.type) || /\.fdseq$/i.test(rel.resolvedTarget)) {
                out.add(normalizePath(rel.resolvedTarget));
            }
        }
    }
    catch (err) {
        diagnostics.push(diag('warning', 'DWFX_ROOT_RELS_FAILED', `Failed to read package relationships: ${String(err)}`));
    }
    for (const o of opc.overrides) {
        if (/fixeddocumentsequence/i.test(o.contentType) || /\.fdseq$/i.test(o.partName))
            out.add(o.partName);
    }
    for (const e of opc.zip.entries) {
        if (/\.fdseq$/i.test(e.name))
            out.add(e.name);
    }
    return Array.from(out);
}
async function collectFixedDocumentPages(opc, fdocPath, pageData, diagnostics) {
    let xml;
    try {
        xml = await opc.readText(fdocPath);
    }
    catch (err) {
        diagnostics.push(diag('warning', 'DWFX_FDOC_READ_FAILED', `Failed to read fixed document ${fdocPath}: ${String(err)}`, fdocPath));
        return;
    }
    const doc = parseXml(xml, fdocPath);
    const pageContents = Array.from(doc.getElementsByTagName('*')).filter(e => localName(e) === 'PageContent');
    for (const pageContent of pageContents) {
        const source = pageContent.getAttribute('Source');
        if (!source)
            continue;
        let pagePath = resolvePart(fdocPath, stripQuery(source));
        const relId = source.startsWith('#') ? source.slice(1) : undefined;
        if (relId) {
            const rels = await opc.getRelationships(fdocPath);
            const rel = rels.find(r => r.id === relId);
            if (rel)
                pagePath = rel.resolvedTarget;
        }
        pagePath = stripQuery(pagePath);
        const widthAttr = pageContent.getAttribute('Width');
        const heightAttr = pageContent.getAttribute('Height');
        const size = widthAttr && heightAttr ? { width: Number(widthAttr), height: Number(heightAttr) } : await readFixedPageSize(opc, pagePath, diagnostics);
        const index = pageData.length + 1;
        pageData.push({
            id: `page-${index}`,
            name: `Page ${index}`,
            kind: 'xps-fixed-page',
            sourcePath: pagePath,
            width: Number.isFinite(size.width) && size.width > 0 ? size.width : 1000,
            height: Number.isFinite(size.height) && size.height > 0 ? size.height : 1000,
            diagnostics: []
        });
    }
}
async function readFixedPageSize(opc, pagePath, diagnostics) {
    try {
        const clean = stripQuery(pagePath);
        const xml = decodeUtf8(await opc.readBytes(clean));
        const doc = parseXml(xml, clean);
        const root = doc.documentElement ?? Array.from(doc.getElementsByTagName('*'))[0];
        return { width: Number(root?.getAttribute('Width') ?? 1000), height: Number(root?.getAttribute('Height') ?? 1000) };
    }
    catch (err) {
        diagnostics.push(diag('warning', 'DWFX_PAGE_SIZE_FAILED', `Failed to read FixedPage size: ${String(err)}`, pagePath));
        return { width: 1000, height: 1000 };
    }
}
function parseDwfManifestSections(xml, sourcePath) {
    const doc = parseXml(xml, sourcePath);
    const sections = Array.from(doc.getElementsByTagName('*')).filter(el => localName(el) === 'Section');
    return sections.map((section, index) => {
        const name = attrAny(section, 'name') ?? `section-${index + 1}`;
        const title = attrAny(section, 'title') ?? name;
        const type = attrAny(section, 'type') ?? '';
        const resources = Array.from(section.getElementsByTagName('*'))
            .filter(el => localName(el).endsWith('Resource') || localName(el) === 'Resource')
            .map(el => {
            const rawPath = attrAny(el, 'href') ?? '';
            return {
                path: normalizePath(stripQuery(rawPath)),
                role: attrAny(el, 'role'),
                mediaType: attrAny(el, 'mime'),
                title: attrAny(el, 'title'),
                size: numberAttr(el, 'size')
            };
        })
            .filter(r => r.path.length > 0);
        return { type, name, title, resources };
    }).filter(s => s.resources.length > 0 || s.type.length > 0);
}
function isEPlotSection(section) {
    return /(^|\.)ePlot$/i.test(section.type) || /com\.autodesk\.dwf\.ePlot$/i.test(section.type);
}
function isEModelSection(section) {
    return /(^|\.)eModel$/i.test(section.type) || /com\.autodesk\.dwf\.eModel$/i.test(section.type);
}
function chooseSectionPreviewResource(section, zip) {
    const candidates = section.resources.filter(r => /^(image\/|application\/octet-stream)/i.test(r.mediaType ?? '') || /\.(png|jpe?g|gif|bmp)$/i.test(r.path));
    const thumbnails = candidates.filter(r => /thumbnail|preview/i.test(r.role ?? '') || /thumbnail|preview/i.test(r.title ?? ''));
    const pool = thumbnails.length > 0 ? thumbnails : candidates.filter(r => !/texture/i.test(r.role ?? ''));
    const finalPool = pool.length > 0 ? pool : candidates;
    return finalPool
        .filter(r => zip.has(r.path))
        .sort((a, b) => scorePreview(b) - scorePreview(a))[0];
}
function scorePreview(r) {
    let s = r.size ?? 0;
    if (/thumbnail/i.test(r.role ?? ''))
        s += 5000000;
    if (/preview/i.test(r.role ?? ''))
        s += 4000000;
    if (/icon/i.test(r.role ?? ''))
        s -= 2000000;
    if (/texture/i.test(r.role ?? ''))
        s -= 3000000;
    return s;
}
function attrAny(el, name) {
    return el.getAttribute(name) ?? el.getAttribute(`dwf:${name}`) ?? el.getAttribute(`ePlot:${name}`) ?? el.getAttribute(`eModel:${name}`) ?? Array.from(el.attributes).find(a => a.localName === name)?.value ?? undefined;
}
function numberAttr(el, name) {
    const raw = attrAny(el, name);
    if (raw === undefined)
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}
function resourceByRole(section, re) {
    return section.resources.find(r => re.test(r.role ?? ''));
}
function stripQuery(path) {
    return normalizePath((path.split(/[?#]/)[0] ?? path).replace(/^\//, ''));
}
function basename(path) {
    const clean = stripQuery(path);
    const i = clean.lastIndexOf('/');
    return i >= 0 ? clean.slice(i + 1) : clean;
}
function imageSizeFromBytes(bytes) {
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return { width: be32(bytes, 16), height: be32(bytes, 20) };
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let p = 2;
        while (p + 9 < bytes.length) {
            if (bytes[p] !== 0xff) {
                p++;
                continue;
            }
            const marker = bytes[p + 1];
            p += 2;
            while (bytes[p] === 0xff)
                p++;
            if (marker === 0xd9 || marker === 0xda)
                break;
            if (p + 2 > bytes.length)
                break;
            const len = (bytes[p] << 8) | bytes[p + 1];
            if (len < 2 || p + len > bytes.length)
                break;
            if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
                return { width: (bytes[p + 5] << 8) | bytes[p + 6], height: (bytes[p + 3] << 8) | bytes[p + 4] };
            }
            p += len;
        }
    }
    return undefined;
}
function be32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
export function getRelationshipById(rels, id) {
    return rels.find(r => r.id === id);
}
