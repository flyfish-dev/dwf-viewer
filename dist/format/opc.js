import { decodeUtf8, parseXml, normalizePath, resolvePart, localName } from './util.js';
export async function createOpcView(zip) {
    const contentTypes = new Map();
    const defaults = new Map();
    const overrides = [];
    if (zip.has('[Content_Types].xml')) {
        const doc = parseXml(decodeUtf8(await zip.read('[Content_Types].xml')), '[Content_Types].xml');
        for (const el of Array.from(doc.documentElement.children)) {
            const name = localName(el);
            if (name === 'Default') {
                const ext = el.getAttribute('Extension')?.toLowerCase();
                const ct = el.getAttribute('ContentType');
                if (ext && ct)
                    defaults.set(ext, ct);
            }
            else if (name === 'Override') {
                const partName = normalizePath((el.getAttribute('PartName') ?? '').replace(/^\//, ''));
                const ct = el.getAttribute('ContentType');
                if (partName && ct) {
                    contentTypes.set(partName, ct);
                    overrides.push({ partName, contentType: ct });
                }
            }
        }
    }
    const relationships = new Map();
    const view = {
        zip,
        contentTypes,
        defaults,
        overrides,
        relationships,
        resources: zip.entries.map(e => ({ path: e.name, mediaType: getContentTypeFor(contentTypes, defaults, e.name), size: e.uncompressedSize })),
        readText: async (path) => decodeUtf8(await zip.read(normalizePath(path))),
        readBytes: async (path) => zip.read(normalizePath(path)),
        getContentType: (path) => getContentTypeFor(contentTypes, defaults, path),
        getRelationships: async (sourcePath = '') => {
            const key = normalizePath(sourcePath);
            const existing = relationships.get(key);
            if (existing)
                return existing;
            const relsPath = relationshipPartName(key);
            if (!zip.has(relsPath)) {
                relationships.set(key, []);
                return [];
            }
            const xml = decodeUtf8(await zip.read(relsPath));
            const doc = parseXml(xml, relsPath);
            const rels = [];
            for (const el of Array.from(doc.documentElement.children)) {
                if (localName(el) !== 'Relationship')
                    continue;
                const id = el.getAttribute('Id') ?? '';
                const type = el.getAttribute('Type') ?? '';
                const target = el.getAttribute('Target') ?? '';
                const targetMode = el.getAttribute('TargetMode') ?? undefined;
                if (!id || !target)
                    continue;
                rels.push({ id, type, target, targetMode, source: key, resolvedTarget: targetMode === 'External' ? target : resolvePart(key, target) });
            }
            relationships.set(key, rels);
            return rels;
        }
    };
    return view;
}
export function relationshipPartName(sourcePath) {
    const source = normalizePath(sourcePath);
    if (!source)
        return '_rels/.rels';
    const slash = source.lastIndexOf('/');
    if (slash < 0)
        return `_rels/${source}.rels`;
    return `${source.slice(0, slash)}/_rels/${source.slice(slash + 1)}.rels`;
}
function getContentTypeFor(overrides, defaults, path) {
    const n = normalizePath(path);
    const o = overrides.get(n);
    if (o)
        return o;
    const dot = n.lastIndexOf('.');
    if (dot >= 0)
        return defaults.get(n.slice(dot + 1).toLowerCase());
    return undefined;
}
