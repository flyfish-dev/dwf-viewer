import type { W3dModelData } from './document.js';
export interface W3dParseOptions {
    title?: string;
    sourcePath?: string;
    maxMeshes?: number;
    maxTriangles?: number;
}
export declare function parseW3dModel(bytes: Uint8Array, options?: W3dParseOptions): Promise<W3dModelData>;
