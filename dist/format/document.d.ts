import type { Diagnostic, DwfDocument, RenderablePage } from './types.js';
import type { ZipPackage } from './zip.js';
import type { OpcPackageView } from './opc.js';
import type { PathCommand } from '../render/xpsPath.js';
import type { Matrix2D } from '../render/style.js';
export interface LoadedDwfDocument extends DwfDocument {
    zip?: ZipPackage;
    opc?: OpcPackageView;
    pageData: PageData[];
}
export type PageData = XpsPageData | W2dTextPageData | ImagePageData | W3dPageData | UnsupportedPageData;
export interface BasePageData extends RenderablePage {
    diagnostics: Diagnostic[];
}
export interface XpsPageData extends BasePageData {
    kind: 'xps-fixed-page';
    sourcePath: string;
}
export interface W2dPrimitiveBase {
    stroke?: string;
    fill?: string;
    lineWidth?: number;
    matrix?: Matrix2D;
}
export type W2dPrimitive = (W2dPrimitiveBase & {
    type: 'polyline';
    points: number[];
}) | (W2dPrimitiveBase & {
    type: 'polygon';
    points: number[];
}) | (W2dPrimitiveBase & {
    type: 'path';
    commands: PathCommand[];
}) | (W2dPrimitiveBase & {
    type: 'text';
    x: number;
    y: number;
    text: string;
    size?: number;
}) | (W2dPrimitiveBase & {
    type: 'rect';
    x: number;
    y: number;
    width: number;
    height: number;
});
export interface W2dTextPageData extends BasePageData {
    kind: 'w2d-text';
    sourcePath: string;
    primitives: W2dPrimitive[];
    bounds?: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
}
export interface ImagePageData extends BasePageData {
    kind: 'image';
    sourcePath: string;
    mediaType: string;
}
export interface W3dMaterialData {
    id: string;
    name?: string;
    color: [number, number, number];
    opacity?: number;
    roughness?: number;
    metalness?: number;
    textureId?: string;
    textureName?: string;
    doubleSided?: boolean;
    source?: string;
}
export interface W3dTextureData {
    id: string;
    name?: string;
    path: string;
    mediaType?: string;
    width?: number;
    height?: number;
    role?: string;
}
export interface W3dSceneNodeData {
    id: string;
    label: string;
    contentRefs: string[];
    meshIds: string[];
    children: W3dSceneNodeData[];
    properties?: Record<string, string>;
}
export interface W3dPmiAnnotationData {
    id: string;
    type: 'text' | 'leader' | 'markup' | 'unknown';
    label?: string;
    text?: string;
    targetRef?: string;
    position?: [number, number, number];
    points?: Array<[number, number, number]>;
    properties?: Record<string, string>;
}
export interface W3dViewData {
    id: string;
    label: string;
    camera?: {
        position?: [number, number, number];
        target?: [number, number, number];
        up?: [number, number, number];
        field?: [number, number, number];
        projection?: 'perspective' | 'orthographic' | string;
    };
}
export interface W3dAnimationData {
    id: string;
    name: string;
    targetRef?: string;
    keyframes?: Array<{
        time: number;
        matrix?: number[];
        visibility?: boolean;
    }>;
}
export interface W3dMeshData {
    id: string;
    name: string;
    positions: Float32Array;
    normals?: Float32Array;
    indices: Uint16Array | Uint32Array;
    edgeIndices?: Uint16Array | Uint32Array;
    vertexCount: number;
    triangleCount: number;
    bounds: {
        min: [number, number, number];
        max: [number, number, number];
    };
    color?: [number, number, number];
    materialId?: string;
    selectionRefs?: string[];
    nodeId?: string;
    sourceStart: number;
    sourceEnd: number;
    decodeKind: 'uncompressed' | `quantized-${number}` | `edgebreaker-v${number}`;
}
export interface W3dModelData {
    kind: 'w3d-model';
    title: string;
    sourcePath?: string;
    meshes: W3dMeshData[];
    bounds: {
        min: [number, number, number];
        max: [number, number, number];
        center: [number, number, number];
        radius: number;
    };
    stats: {
        meshCount: number;
        vertexCount: number;
        triangleCount: number;
        decodedBytes: number;
        edgeCount?: number;
        materialCount?: number;
        textureCount?: number;
        pmiCount?: number;
        nodeCount?: number;
    };
    materials?: W3dMaterialData[];
    textures?: W3dTextureData[];
    sceneTree?: W3dSceneNodeData[];
    pmi?: W3dPmiAnnotationData[];
    views?: W3dViewData[];
    animations?: W3dAnimationData[];
    initialView?: W3dViewData;
    metadata?: Record<string, string>;
    diagnostics: Diagnostic[];
}
export interface W3dPageData extends BasePageData {
    kind: 'w3d-model';
    sourcePath: string;
    model: W3dModelData;
}
export interface UnsupportedPageData extends BasePageData {
    kind: 'unsupported';
    sourcePath?: string;
    reason: string;
}
export declare function makeLoadedDocument(base: DwfDocument, pageData: PageData[], zip?: ZipPackage, opc?: OpcPackageView): LoadedDwfDocument;
