import { diag } from './types.js';
import { bytesLookTextual, decodeUtf8, extname, mimeFromPath, normalizePath, parseNumberList, parseXml } from './util.js';
import { makeLoadedDocument } from './document.js';
import { parseW2dText } from './w2dText.js';
import { parseW2dBinary } from './w2dBinary.js';
export function isProbablyClassicDwf(zip) {
    return zip.entries.some(e => /\.w2d$/i.test(e.name) || /manifest\.xml$/i.test(e.name) || /descriptor\.xml$/i.test(e.name) || /\.hsf$/i.test(e.name));
}
export async function openClassicDwf(zip) {
    const diagnostics = [];
    const pageData = [];
    const resources = zip.entries.map(e => ({ path: e.name, mediaType: mimeFromPath(e.name), size: e.uncompressedSize }));
    const manifestEntry = zip.entries.find(e => /(^|\/)manifest\.xml$/i.test(e.name));
    let manifestSections = [];
    if (manifestEntry) {
        try {
            manifestSections = parseManifestSections(decodeUtf8(await zip.read(manifestEntry)), manifestEntry.name);
            diagnostics.push(diag('info', 'DWF_MANIFEST_FOUND', `Found DWF manifest with ${manifestSections.length} section(s).`, manifestEntry.name));
        }
        catch (err) {
            diagnostics.push(diag('warning', 'DWF_MANIFEST_PARSE_FAILED', `Failed to parse DWF manifest: ${String(err)}`, manifestEntry.name));
        }
    }
    else {
        diagnostics.push(diag('info', 'DWF_NO_MANIFEST', 'No manifest.xml was found; falling back to resource discovery.'));
    }
    if (manifestSections.length > 0) {
        for (const section of manifestSections) {
            const mainGraphic = resourceByRole(section, /2d\s+streaming\s+graphics/i) ?? section.resources.find(r => /\.w2d$/i.test(r.path));
            if (!mainGraphic)
                continue;
            const descriptorResource = resourceByRole(section, /^descriptor$/i) ?? { path: normalizePath(section.name + '/descriptor.xml') };
            let descriptor = {};
            if (descriptorResource && zip.has(descriptorResource.path)) {
                try {
                    descriptor = parseDescriptorInfo(decodeUtf8(await zip.read(descriptorResource.path)), mainGraphic.path);
                }
                catch (err) {
                    diagnostics.push(diag('warning', 'DWF_DESCRIPTOR_PARSE_FAILED', `Failed to parse descriptor for ${section.title}: ${String(err)}`, descriptorResource.path));
                }
            }
            const pageDiagnostics = [];
            const primitives = [];
            try {
                const parsed = await parseW2dResource(zip, mainGraphic.path);
                primitives.push(...parsed.primitives);
                pageDiagnostics.push(...parsed.diagnostics);
            }
            catch (err) {
                pageDiagnostics.push(diag('warning', 'DWF_W2D_READ_FAILED', `Failed to read or parse ${mainGraphic.path}: ${String(err)}`, mainGraphic.path));
            }
            for (const markupXml of section.resources.filter(r => /markup\s+private/i.test(r.role ?? '') && /\.xml$/i.test(r.path))) {
                if (!zip.has(markupXml.path))
                    continue;
                try {
                    const parsed = parseMarkupPrivateXml(decodeUtf8(await zip.read(markupXml.path)), markupXml.path, descriptor.w2dTransform);
                    primitives.push(...parsed.primitives);
                    pageDiagnostics.push(...parsed.diagnostics);
                }
                catch (err) {
                    pageDiagnostics.push(diag('warning', 'DWF_MARKUP_XML_PARSE_FAILED', `Failed to parse markup private XML: ${String(err)}`, markupXml.path));
                }
            }
            if (primitives.length > 0) {
                const bounds = computeBounds(primitives);
                const width = bounds ? Math.max(1, bounds.maxX - bounds.minX) : descriptor.paperWidth ?? 1000;
                const height = bounds ? Math.max(1, bounds.maxY - bounds.minY) : descriptor.paperHeight ?? 1000;
                pageData.push({
                    id: `page-${pageData.length + 1}`,
                    name: section.title || mainGraphic.title || basename(mainGraphic.path),
                    kind: 'w2d-text',
                    sourcePath: mainGraphic.path,
                    width,
                    height,
                    primitives,
                    bounds,
                    diagnostics: pageDiagnostics
                });
            }
            else {
                const thumb = resourceByRole(section, /thumbnail|preview/i) ?? section.resources.find(r => /\.(png|jpe?g|gif|bmp)$/i.test(r.path));
                if (thumb && zip.has(thumb.path)) {
                    pageData.push({
                        id: `image-${pageData.length + 1}`,
                        name: section.title || basename(thumb.path),
                        kind: 'image',
                        sourcePath: thumb.path,
                        mediaType: thumb.mediaType ?? mimeFromPath(thumb.path) ?? 'image/png',
                        width: 1000,
                        height: 1000,
                        diagnostics: [...pageDiagnostics, diag('warning', 'DWF_IMAGE_FALLBACK', 'Vector stream did not produce geometry; using section thumbnail as fallback.', thumb.path)]
                    });
                }
            }
        }
    }
    if (pageData.length === 0) {
        await discoverW2dResources(zip, pageData, diagnostics);
    }
    const hsfEntries = zip.entries.filter(e => /\.hsf$/i.test(e.name));
    if (hsfEntries.length > 0) {
        diagnostics.push(diag('warning', 'DWF_3D_HSF_DETECTED', `Detected ${hsfEntries.length} HSF/3D resource(s). This frontend build reports them but does not render 3D HSF.`, hsfEntries[0]?.name));
        if (pageData.length === 0) {
            pageData.push({
                id: 'unsupported-3d',
                name: 'Unsupported 3D DWF',
                kind: 'unsupported',
                width: 1000,
                height: 1000,
                sourcePath: hsfEntries[0]?.name,
                reason: '3D HSF resource detected; not implemented in this pure frontend native renderer build.',
                diagnostics: [diag('warning', 'DWF_3D_HSF_UNSUPPORTED', '3D HSF rendering is not implemented in this build.', hsfEntries[0]?.name)]
            });
        }
    }
    if (pageData.length === 0) {
        const imageEntry = chooseBestImage(zip);
        if (imageEntry) {
            pageData.push({
                id: 'image-1',
                name: basename(imageEntry.name),
                kind: 'image',
                sourcePath: imageEntry.name,
                mediaType: mimeFromPath(imageEntry.name) ?? 'image/png',
                width: 1000,
                height: 1000,
                diagnostics: [diag('info', 'DWF_IMAGE_FALLBACK', 'No supported vector page was found; using an embedded preview/image resource.', imageEntry.name)]
            });
        }
    }
    if (pageData.length === 0) {
        pageData.push({
            id: 'unsupported-1',
            name: 'Unsupported DWF package',
            kind: 'unsupported',
            width: 1000,
            height: 1000,
            reason: 'No supported W2D, XPS FixedPage, or preview image resource was found.',
            diagnostics: [diag('error', 'DWF_NO_SUPPORTED_PAGE', 'No supported renderable DWF resource was found.')]
        });
    }
    const base = {
        kind: 'dwf',
        pages: [],
        resources,
        diagnostics,
        packageEntries: zip.entries.map(e => e.name)
    };
    return makeLoadedDocument(base, pageData, zip, undefined);
}
async function discoverW2dResources(zip, pageData, diagnostics) {
    const w2dEntries = zip.entries.filter(e => /\.w2d$/i.test(e.name));
    for (const entry of w2dEntries) {
        try {
            const parsed = await parseW2dResource(zip, entry.name);
            const bounds = parsed.bounds;
            const width = bounds ? Math.max(1, bounds.maxX - bounds.minX) : 1000;
            const height = bounds ? Math.max(1, bounds.maxY - bounds.minY) : 1000;
            if (parsed.primitives.length > 0) {
                pageData.push({
                    id: `page-${pageData.length + 1}`,
                    name: basename(entry.name),
                    kind: 'w2d-text',
                    sourcePath: entry.name,
                    width,
                    height,
                    primitives: parsed.primitives,
                    bounds,
                    diagnostics: parsed.diagnostics
                });
            }
        }
        catch (err) {
            diagnostics.push(diag('warning', 'DWF_W2D_READ_FAILED', `Failed to read ${entry.name}: ${String(err)}`, entry.name));
        }
    }
}
async function parseW2dResource(zip, path) {
    const bytes = await zip.read(path);
    if (bytesLookTextual(bytes))
        return parseW2dText(bytes, path);
    return parseW2dBinary(bytes, path);
}
function parseManifestSections(xml, sourcePath) {
    const doc = parseXml(xml, sourcePath);
    const sections = Array.from(doc.getElementsByTagName('*')).filter(el => local(el) === 'Section');
    return sections.map((section, index) => {
        const name = attrAny(section, 'name') ?? `section-${index + 1}`;
        const title = attrAny(section, 'title') ?? name;
        const resources = Array.from(section.getElementsByTagName('*'))
            .filter(el => local(el).endsWith('Resource') || local(el) === 'Resource')
            .map(el => ({
            path: normalizePath(attrAny(el, 'href') ?? ''),
            role: attrAny(el, 'role'),
            mediaType: attrAny(el, 'mime'),
            title: attrAny(el, 'title')
        }))
            .filter(r => r.path.length > 0);
        return { name, title, resources };
    }).filter(s => s.resources.length > 0);
}
function parseDescriptorInfo(xml, mainGraphicPath) {
    const doc = parseXml(xml, 'descriptor.xml');
    const paper = Array.from(doc.getElementsByTagName('*')).find(el => local(el) === 'Paper');
    const info = {};
    if (paper) {
        info.paperWidth = numAttr(paper, 'width');
        info.paperHeight = numAttr(paper, 'height');
        const clip = attrAny(paper, 'clip');
        if (clip)
            info.clip = parseNumberList(clip);
    }
    const graphics = Array.from(doc.getElementsByTagName('*')).filter(el => /GraphicResource$/i.test(local(el)) || local(el) === 'GraphicResource');
    const main = graphics.find(el => normalizePath(attrAny(el, 'href') ?? '') === normalizePath(mainGraphicPath))
        ?? graphics.find(el => /2d\s+streaming\s+graphics/i.test(attrAny(el, 'role') ?? ''));
    const transform = main ? parseNumberList(attrAny(main, 'transform') ?? '') : [];
    if (transform.length >= 14) {
        info.w2dTransform = { sx: transform[0] || 1, sy: transform[5] || transform[0] || 1, tx: transform[12] || 0, ty: transform[13] || 0 };
    }
    return info;
}
function parseMarkupPrivateXml(xml, sourcePath, transform) {
    const doc = parseXml(xml, sourcePath);
    const primitives = [];
    const toLogical = (x, y) => transform
        ? { x: (x - transform.tx) / transform.sx, y: (y - transform.ty) / transform.sy }
        : { x, y };
    const pointsAttr = (el) => parseNumberList(attrAny(el, 'Points') ?? attrAny(el, 'points') ?? '');
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
        const name = local(el);
        if (name === 'Polyline2D' || name === 'Leader') {
            const nums = pointsAttr(el);
            if (nums.length >= 4) {
                const pts = [];
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    const p = toLogical(nums[i], nums[i + 1]);
                    pts.push(p.x, p.y);
                }
                const style = styleFromMarkup(el);
                primitives.push({ type: 'polyline', points: pts, stroke: style.stroke, lineWidth: style.lineWidth });
            }
        }
        else if (name === 'Tag' || name === 'Target') {
            const cx = numAttr(el, 'CenterX'), cy = numAttr(el, 'CenterY'), w = numAttr(el, 'Width'), h = numAttr(el, 'Height');
            if ([cx, cy, w, h].every(n => n !== undefined)) {
                const p1 = toLogical(cx - w / 2, cy - h / 2);
                const p2 = toLogical(cx + w / 2, cy - h / 2);
                const p3 = toLogical(cx + w / 2, cy + h / 2);
                const p4 = toLogical(cx - w / 2, cy + h / 2);
                const style = styleFromMarkup(el);
                primitives.push({ type: 'polygon', points: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y], stroke: style.stroke, fill: style.fill, lineWidth: style.lineWidth });
            }
        }
        else if (name === 'Text') {
            const x = numAttr(el, 'X'), y = numAttr(el, 'Y');
            if (x !== undefined && y !== undefined) {
                const phrases = Array.from(el.getElementsByTagName('*')).filter(child => local(child) === 'TextPhrase');
                const text = phrases.map(p => attrAny(p, 'String') ?? '').filter(Boolean).join('\n');
                if (text) {
                    const p = toLogical(x, y);
                    const heightPaper = numAttr(el, 'Height');
                    const fontHeight = phrases.length ? numAttr(phrases[0], 'FontHeight') : undefined;
                    const size = transform && heightPaper ? Math.max(10, Math.abs(heightPaper / transform.sy)) : (fontHeight ?? 12);
                    const colorAttr = phrases.length ? attrAny(phrases[0], 'Color') : undefined;
                    primitives.push({ type: 'text', x: p.x, y: p.y, text, size, fill: colorAttr ? signedIntColor(colorAttr) : styleFromMarkup(el).stroke });
                }
            }
        }
    }
    const diagnostics = [];
    if (primitives.length > 0)
        diagnostics.push(diag('info', 'DWF_MARKUP_XML_PARSED', `Parsed ${primitives.length} markup primitive(s) from markup private XML.`, sourcePath));
    return { primitives, diagnostics };
}
function styleFromMarkup(el) {
    let stroke = '#0000ff';
    let fill;
    let lineWidth = 1;
    const props = Array.from(el.getElementsByTagName('*')).filter(e => local(e) === 'FormatProperty');
    for (const p of props) {
        const name = (attrAny(p, 'Name') ?? '').toUpperCase();
        const enabled = (attrAny(p, 'Enabled') ?? 'true').toLowerCase() !== 'false';
        const value = attrAny(p, 'ModifierUIntVal') ?? attrAny(p, 'UIntValue') ?? attrAny(p, 'DblValue') ?? attrAny(p, 'IntValue');
        if (!enabled || value === undefined)
            continue;
        if (name === 'LINECOLOR')
            stroke = signedIntColor(value);
        if (name === 'FILLCOLOR')
            fill = signedIntColor(value);
        if (name === 'LINEWEIGHT')
            lineWidth = Math.max(1, Number(value) || lineWidth);
        if (name === 'NOFILL' && /true/i.test(attrAny(p, 'BoolValue') ?? ''))
            fill = undefined;
    }
    return { stroke, fill, lineWidth };
}
function signedIntColor(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return '#000000';
    const u = n >>> 0;
    const r = (u >>> 16) & 255;
    const g = (u >>> 8) & 255;
    const b = u & 255;
    return `rgb(${r}, ${g}, ${b})`;
}
function computeBounds(primitives) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const p of primitives) {
        if ('points' in p) {
            for (let i = 0; i + 1 < p.points.length; i += 2)
                add(p.points[i], p.points[i + 1]);
        }
        else if (p.type === 'rect') {
            add(p.x, p.y);
            add(p.x + p.width, p.y + p.height);
        }
        else if (p.type === 'text') {
            const size = p.size ?? 12;
            add(p.x, p.y);
            add(p.x, p.y + size);
        }
        else if (p.type === 'path') {
            for (const c of p.commands) {
                if ('x' in c && 'y' in c)
                    add(c.x, c.y);
                if ('x1' in c && 'y1' in c)
                    add(c.x1, c.y1);
                if ('x2' in c && 'y2' in c)
                    add(c.x2, c.y2);
            }
        }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}
function resourceByRole(section, re) {
    return section.resources.find(r => re.test(r.role ?? ''));
}
function attrAny(el, name) {
    return el.getAttribute(name) ?? el.getAttribute(`dwf:${name}`) ?? el.getAttribute(`ePlot:${name}`) ?? Array.from(el.attributes).find(a => a.localName === name)?.value ?? undefined;
}
function local(el) {
    const n = el.localName || el.nodeName;
    const i = n.indexOf(':');
    return i >= 0 ? n.slice(i + 1) : n;
}
function numAttr(el, name) {
    const raw = attrAny(el, name);
    if (raw === undefined)
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}
function basename(path) {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}
function chooseBestImage(zip) {
    const images = zip.entries.filter(e => /\.(png|jpe?g|gif|bmp)$/i.test(e.name));
    if (images.length === 0)
        return undefined;
    return images.sort((a, b) => scoreImage(b.name, b.uncompressedSize) - scoreImage(a.name, a.uncompressedSize))[0];
}
function scoreImage(path, size) {
    let s = Math.min(size, 10000000) / 1000;
    if (/thumbnail|preview/i.test(path))
        s += 5000;
    if (extname(path) === 'png')
        s += 100;
    return s;
}
