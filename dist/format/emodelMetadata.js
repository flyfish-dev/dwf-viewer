import { decodeUtf8, localName, parseXml } from './util.js';
import { diag } from './types.js';
export async function enrichW3dModelFromEModelResources(model, resources, opc) {
    const diagnostics = model.diagnostics;
    model.metadata ?? (model.metadata = {});
    model.materials ?? (model.materials = []);
    model.textures ?? (model.textures = []);
    model.sceneTree ?? (model.sceneTree = []);
    model.pmi ?? (model.pmi = []);
    model.views ?? (model.views = []);
    model.animations ?? (model.animations = []);
    await collectTextures(model, resources, opc, diagnostics);
    const descriptor = resources.find(r => /descriptor/i.test(r.role ?? '') || /descriptor\.xml$/i.test(r.path));
    if (descriptor && opc.zip.has(descriptor.path)) {
        try {
            parseDescriptor(model, decodeUtf8(await opc.readBytes(descriptor.path)), descriptor.path);
        }
        catch (err) {
            diagnostics.push(diag('warning', 'EMODEL_DESCRIPTOR_PARSE_FAILED', `Failed to parse eModel descriptor: ${String(err)}`, descriptor.path));
        }
    }
    const contentDef = resources.find(r => /content\s+definition/i.test(r.role ?? ''));
    const instanceInfos = contentDef && opc.zip.has(contentDef.path)
        ? parseContentDefinitionSafe(model, decodeUtf8(await opc.readBytes(contentDef.path)), contentDef.path, diagnostics)
        : [];
    const presentation = resources.find(r => /content\s+presentation/i.test(r.role ?? ''));
    const labelByContentRef = new Map();
    let instanceMaterials = new Map();
    if (presentation && opc.zip.has(presentation.path)) {
        try {
            const { nodes, pmi, views, animations, materials } = parseContentPresentation(decodeUtf8(await opc.readBytes(presentation.path)), presentation.path, labelByContentRef);
            instanceMaterials = materials;
            model.sceneTree = nodes;
            model.pmi = pmi;
            model.views = mergeViews(model.views ?? [], views);
            model.animations = animations;
            const existing = new Map((model.materials ?? []).map(m => [m.id, m]));
            for (const mat of materials.values())
                existing.set(mat.id, bindTextureByName(mat, model.textures ?? []));
            model.materials = Array.from(existing.values());
        }
        catch (err) {
            diagnostics.push(diag('warning', 'EMODEL_PRESENTATION_PARSE_FAILED', `Failed to parse eModel presentation: ${String(err)}`, presentation.path));
        }
    }
    attachSelectionMetadata(model, instanceInfos, labelByContentRef, instanceMaterials);
    const nodeCount = countSceneNodes(model.sceneTree ?? []);
    if ((model.views?.length ?? 0) > 0 && !model.initialView)
        model.initialView = model.views[0];
    model.stats.materialCount = model.materials?.length ?? 0;
    model.stats.textureCount = model.textures?.length ?? 0;
    model.stats.pmiCount = model.pmi?.length ?? 0;
    model.stats.nodeCount = nodeCount;
}
async function collectTextures(model, resources, opc, diagnostics) {
    const textures = [];
    for (const r of resources.filter(x => /texture/i.test(x.role ?? '') || /texture/i.test(x.title ?? ''))) {
        if (!opc.zip.has(r.path))
            continue;
        let width;
        let height;
        try {
            const size = imageSizeFromBytes(await opc.readBytes(r.path));
            width = size?.width;
            height = size?.height;
        }
        catch (err) {
            diagnostics.push(diag('warning', 'EMODEL_TEXTURE_SIZE_FAILED', `Failed to read texture size: ${String(err)}`, r.path));
        }
        textures.push({ id: r.path, name: cleanTitle(r.title) ?? basename(r.path), path: r.path, mediaType: r.mediaType, width, height, role: r.role });
    }
    model.textures = textures;
    if (textures.length > 0) {
        const tex = textures.find(t => /thread/i.test(t.name ?? '')) ?? textures.find(t => !/environment/i.test(t.name ?? '')) ?? textures[0];
        if (tex) {
            const defaultMat = { id: 'dwfx-default-textured', name: 'DWFx default material', color: [0.72, 0.74, 0.78], textureId: tex.id, roughness: 0.6, metalness: 0.03, doubleSided: true, source: tex.path };
            model.materials = [defaultMat];
            // Do not forcibly assign the texture to every mesh; many DWFx files use environment maps or icons.
        }
    }
}
function parseDescriptor(model, xml, sourcePath) {
    const doc = parseXml(xml, sourcePath);
    const root = doc.documentElement;
    if (root) {
        const units = Array.from(root.getElementsByTagName('*')).find(e => localName(e) === 'Units');
        const unitType = units?.getAttribute('type');
        if (unitType)
            model.metadata.units = unitType;
        const spaceName = root.getAttribute('name');
        if (spaceName)
            model.metadata.spaceName = spaceName;
    }
    for (const prop of Array.from(doc.getElementsByTagName('*')).filter(e => localName(e) === 'Property')) {
        const name = prop.getAttribute('name');
        const value = prop.getAttribute('value');
        if (name && value)
            model.metadata[name] = value;
    }
    const home = makeViewFromDescriptorProperties(model.metadata);
    if (home) {
        model.views = mergeViews(model.views ?? [], [home]);
        model.initialView = home;
    }
}
function makeViewFromDescriptorProperties(meta) {
    const position = vector3(meta._ViewCubeHomeCameraPosition);
    const target = vector3(meta._ViewCubeHomeCameraTarget);
    const up = vector3(meta._ViewCubeHomeCameraUpVector);
    const field = vector3(meta._ViewCubeHomeCameraField);
    if (!position && !target && !up)
        return undefined;
    return { id: 'descriptor-home-view', label: 'Home', camera: { position, target, up, field, projection: meta._ViewCubeHomeCameraProjection === '1' ? 'perspective' : 'orthographic' } };
}
function parseContentDefinitionSafe(model, xml, sourcePath, diagnostics) {
    try {
        const doc = parseXml(xml, sourcePath);
        const instances = [];
        for (const el of Array.from(doc.getElementsByTagName('*')).filter(e => localName(e) === 'Instance')) {
            const id = el.getAttribute('id') ?? '';
            if (!id)
                continue;
            instances.push({ id, renderableRef: el.getAttribute('renderableRef') ?? undefined, node: el.getAttribute('node') ?? undefined, geometricVariation: el.getAttribute('geometricVariation') ?? undefined });
        }
        model.metadata.contentInstanceCount = String(instances.length);
        return instances;
    }
    catch (err) {
        diagnostics.push(diag('warning', 'EMODEL_CONTENTDEF_PARSE_FAILED', `Failed to parse eModel content definition: ${String(err)}`, sourcePath));
        return [];
    }
}
function parseContentPresentation(xml, sourcePath, labelByContentRef) {
    const doc = parseXml(xml, sourcePath);
    const topContainers = Array.from(doc.getElementsByTagName('*')).filter(e => localName(e) === 'View');
    const nodes = [];
    for (const view of topContainers) {
        const viewNodes = nodeChildrenUnder(view);
        for (const n of viewNodes)
            nodes.push(parseSceneNode(n, labelByContentRef));
    }
    if (nodes.length === 0) {
        for (const n of Array.from(doc.getElementsByTagName('*')).filter(e => localName(e) === 'ReferenceNode' && !hasAncestorReferenceNode(e)))
            nodes.push(parseSceneNode(n, labelByContentRef));
    }
    const views = [];
    for (const modelView of Array.from(doc.getElementsByTagName('*')).filter(e => /ModelViewNode|View/i.test(localName(e)))) {
        const id = modelView.getAttribute('id') ?? `view-${views.length + 1}`;
        const label = modelView.getAttribute('label') ?? modelView.getAttribute('name') ?? id;
        const camEl = directChildren(modelView).find(e => localName(e) === 'Camera') ?? Array.from(modelView.getElementsByTagName('*')).find(e => localName(e) === 'Camera');
        const camera = camEl ? cameraFromElement(camEl) : undefined;
        if (camera || /ModelViewNode/i.test(localName(modelView)))
            views.push({ id, label, camera });
    }
    const pmi = [];
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
        const ln = localName(el);
        if (!/PMI|Markup|Dimension|Annotation|Callout|Leader|Note/i.test(ln))
            continue;
        pmi.push({ id: el.getAttribute('id') ?? `pmi-${pmi.length + 1}`, type: /Leader/i.test(ln) ? 'leader' : /Text|Note|Dimension/i.test(ln) ? 'text' : 'markup', label: el.getAttribute('label') ?? el.getAttribute('name') ?? ln, text: el.getAttribute('text') ?? el.textContent?.trim() ?? undefined, targetRef: el.getAttribute('contentElementRefs') ?? el.getAttribute('target') ?? undefined, properties: attributesToRecord(el) });
    }
    const animations = [];
    for (const el of Array.from(doc.getElementsByTagName('*')).filter(e => /Animation|Sequence|Timeline/i.test(localName(e)))) {
        animations.push({ id: el.getAttribute('id') ?? `animation-${animations.length + 1}`, name: el.getAttribute('label') ?? el.getAttribute('name') ?? localName(el), targetRef: el.getAttribute('target') ?? undefined });
    }
    const materials = parseInstanceMaterials(doc);
    return { nodes, pmi, views: dedupeViews(views), animations, materials };
}
function parseInstanceMaterials(doc) {
    const out = new Map();
    for (const inst of Array.from(doc.getElementsByTagName('*')).filter(e => localName(e) === 'InstanceAttributes')) {
        const id = inst.getAttribute('id');
        if (!id)
            continue;
        const colorEl = directChildren(inst).find(e => localName(e) === 'Color') ?? Array.from(inst.getElementsByTagName('*')).find(e => localName(e) === 'Color');
        if (!colorEl)
            continue;
        const diffuse = Array.from(colorEl.getElementsByTagName('*')).find(e => localName(e) === 'Channel' && /diffuse/i.test(e.getAttribute('type') ?? ''));
        const env = Array.from(colorEl.getElementsByTagName('*')).find(e => localName(e) === 'Channel' && /environment/i.test(e.getAttribute('type') ?? ''));
        const red = Number(diffuse?.getAttribute('red'));
        const green = Number(diffuse?.getAttribute('green'));
        const blue = Number(diffuse?.getAttribute('blue'));
        if (![red, green, blue].every(Number.isFinite))
            continue;
        const gloss = Number(colorEl.getAttribute('gloss'));
        const textureName = cleanTitle(env?.getAttribute('name') ?? undefined);
        out.set(id, {
            id: `material-${id}`,
            name: `Material ${id}`,
            color: [red, green, blue],
            opacity: 1,
            roughness: Number.isFinite(gloss) ? Math.max(0.12, Math.min(0.92, 1 - gloss / 128)) : 0.58,
            metalness: 0.03,
            textureName,
            doubleSided: true,
            source: 'content-presentation'
        });
    }
    return out;
}
function bindTextureByName(material, textures) {
    if (material.textureId || !material.textureName)
        return material;
    const norm = normalizeMaterialName(material.textureName);
    const match = textures.find(t => normalizeMaterialName(t.name ?? '').includes(norm) || norm.includes(normalizeMaterialName(t.name ?? '')));
    return match ? { ...material, textureId: match.id } : material;
}
function normalizeMaterialName(s) {
    return s.replace(/&quot;/g, '').replace(/["{}]/g, '').toLowerCase();
}
function parseSceneNode(el, labelByContentRef) {
    const refs = splitRefs(el.getAttribute('contentElementRefs') ?? el.getAttribute('contentRefs') ?? '');
    const node = {
        id: el.getAttribute('id') ?? `node-${Math.random().toString(36).slice(2)}`,
        label: el.getAttribute('label') ?? el.getAttribute('name') ?? localName(el),
        contentRefs: refs,
        meshIds: [],
        children: [],
        properties: attributesToRecord(el)
    };
    for (const ref of refs)
        labelByContentRef.set(ref, node);
    for (const child of nodeChildrenUnder(el))
        node.children.push(parseSceneNode(child, labelByContentRef));
    return node;
}
function attachSelectionMetadata(model, instances, labelByContentRef, instanceMaterials) {
    const labelForRef = new Map(labelByContentRef);
    instances.forEach((inst, i) => {
        const mesh = model.meshes[i];
        if (!mesh)
            return;
        const refs = [inst.renderableRef, inst.id].filter(Boolean);
        mesh.selectionRefs = refs;
        mesh.nodeId = inst.node;
        const mat = instanceMaterials.get(inst.id) ?? (inst.renderableRef ? instanceMaterials.get(inst.renderableRef) : undefined);
        if (mat) {
            mesh.materialId = mat.id;
            mesh.color = mat.color;
        }
        for (const ref of refs) {
            const node = labelForRef.get(ref);
            if (node) {
                mesh.name = node.label || mesh.name;
                node.meshIds.push(mesh.id);
                break;
            }
        }
    });
}
function cameraFromElement(el) {
    const pos = attrsVector3(el, 'positionX', 'positionY', 'positionZ');
    const target = attrsVector3(el, 'targetX', 'targetY', 'targetZ');
    const up = attrsVector3(el, 'upVectorX', 'upVectorY', 'upVectorZ');
    const field = attrsVector3(el, 'fieldWidth', 'fieldHeight', 'fieldDepth');
    return { position: pos, target, up, field, projection: el.getAttribute('projectionType') ?? undefined };
}
function attrsVector3(el, x, y, z) {
    const nums = [Number(el.getAttribute(x)), Number(el.getAttribute(y)), Number(el.getAttribute(z))];
    return nums.every(Number.isFinite) ? nums : undefined;
}
function vector3(raw) {
    if (!raw)
        return undefined;
    const n = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    return n.length >= 3 ? [n[0], n[1], n[2]] : undefined;
}
function directChildren(el) {
    return Array.from(el.children);
}
function nodeChildrenUnder(el) {
    const out = [];
    for (const child of directChildren(el)) {
        const ln = localName(child);
        if (ln.endsWith('Node'))
            out.push(child);
        else if (ln === 'Nodes' || ln === 'Views') {
            for (const grand of directChildren(child))
                if (localName(grand).endsWith('Node'))
                    out.push(grand);
        }
    }
    return out;
}
function hasAncestorReferenceNode(el) {
    let p = parentElementOf(el);
    while (p) {
        if (localName(p) === 'ReferenceNode')
            return true;
        p = parentElementOf(p);
    }
    return false;
}
function parentElementOf(el) {
    return (el.parentElement ?? el.parentNode) || undefined;
}
function attributesToRecord(el) {
    const out = {};
    for (const a of Array.from(el.attributes))
        out[a.localName || a.name] = a.value;
    return out;
}
function splitRefs(raw) {
    return raw.trim().split(/[\s,]+/).filter(Boolean);
}
function mergeViews(a, b) {
    return dedupeViews([...a, ...b]);
}
function dedupeViews(views) {
    const seen = new Set();
    const out = [];
    for (const v of views) {
        const key = v.id || v.label;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}
function countSceneNodes(nodes) {
    let n = 0;
    for (const node of nodes)
        n += 1 + countSceneNodes(node.children);
    return n;
}
function basename(path) {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
}
function cleanTitle(raw) {
    if (!raw)
        return undefined;
    return raw.replace(/^"|"$/g, '').replace(/&quot;/g, '"');
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
