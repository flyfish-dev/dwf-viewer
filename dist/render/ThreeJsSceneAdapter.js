/**
 * Convert a decoded DWFx/W3D model into a real THREE.Group.
 *
 * This helper accepts the THREE namespace as an argument so the core viewer remains
 * buildable offline without bundling npm dependencies.  Pass `textureResolver` to
 * bind DWFx package image resources to Three.js Texture objects in your app layer.
 */
export function createThreeGroupFromW3d(pageOrModel, THREE, options = {}) {
    const model = pageOrModel.model ?? pageOrModel;
    const group = new THREE.Group();
    group.name = model.title ?? 'DWFx W3D Model';
    const materialById = new Map((model.materials ?? []).map(m => [m.id, m]));
    const textureById = new Map((model.textures ?? []).map(t => [t.id, t]));
    for (const mesh of model.meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
        if (mesh.normals)
            geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        const srcMaterial = mesh.materialId ? materialById.get(mesh.materialId) : undefined;
        const color = srcMaterial?.color ?? mesh.color ?? [0.72, 0.74, 0.78];
        const materialOptions = {
            color: THREE.Color ? new THREE.Color(color[0], color[1], color[2]) : undefined,
            roughness: srcMaterial?.roughness ?? options.roughness ?? 0.55,
            metalness: srcMaterial?.metalness ?? options.metalness ?? 0.04,
            transparent: srcMaterial?.opacity !== undefined && srcMaterial.opacity < 1,
            opacity: srcMaterial?.opacity ?? 1
        };
        if ((options.doubleSide || srcMaterial?.doubleSided) && THREE.DoubleSide !== undefined)
            materialOptions.side = THREE.DoubleSide;
        const tex = srcMaterial?.textureId ? textureById.get(srcMaterial.textureId) : undefined;
        if (tex && options.textureResolver)
            materialOptions.map = options.textureResolver(tex, srcMaterial);
        const material = new THREE.MeshStandardMaterial(materialOptions);
        const obj = new THREE.Mesh(geometry, material);
        obj.name = mesh.name;
        obj.userData = { sourceStart: mesh.sourceStart, sourceEnd: mesh.sourceEnd, decodeKind: mesh.decodeKind, selectionRefs: mesh.selectionRefs, nodeId: mesh.nodeId, materialId: mesh.materialId };
        group.add(obj);
        if (options.showFeatureEdges !== false && mesh.edgeIndices && THREE.LineSegments && THREE.LineBasicMaterial) {
            const edgeGeometry = new THREE.BufferGeometry();
            edgeGeometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
            edgeGeometry.setIndex(new THREE.BufferAttribute(mesh.edgeIndices, 1));
            const edgeMaterial = new THREE.LineBasicMaterial({ color: options.edgeColor ?? 0x111111, transparent: true, opacity: 0.52 });
            const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
            edges.name = `${mesh.name} feature edges`;
            edges.userData = { sourceMeshId: mesh.id, selectionRefs: mesh.selectionRefs, nodeId: mesh.nodeId };
            group.add(edges);
        }
    }
    group.userData = { bounds: model.bounds, stats: model.stats, sourcePath: model.sourcePath, sceneTree: model.sceneTree, pmi: model.pmi, views: model.views, textures: model.textures, materials: model.materials };
    return group;
}
