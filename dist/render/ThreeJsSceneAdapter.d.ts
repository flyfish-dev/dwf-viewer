import type { W3dMaterialData, W3dPageData, W3dModelData, W3dTextureData } from '../format/document.js';
export interface ThreeLikeNamespace {
    Group: new () => any;
    BufferGeometry: new () => any;
    BufferAttribute: new (array: ArrayLike<number>, itemSize: number) => any;
    MeshStandardMaterial: new (options?: Record<string, unknown>) => any;
    MeshBasicMaterial?: new (options?: Record<string, unknown>) => any;
    LineBasicMaterial?: new (options?: Record<string, unknown>) => any;
    Mesh: new (geometry: any, material: any) => any;
    LineSegments?: new (geometry: any, material: any) => any;
    Color?: new (r: number, g: number, b: number) => any;
    DoubleSide?: number;
}
export interface ThreeAdapterOptions {
    doubleSide?: boolean;
    roughness?: number;
    metalness?: number;
    showFeatureEdges?: boolean;
    edgeColor?: number | string;
    textureResolver?: (texture: W3dTextureData, material: W3dMaterialData) => unknown;
}
/**
 * Convert a decoded DWFx/W3D model into a real THREE.Group.
 *
 * This helper accepts the THREE namespace as an argument so the core viewer remains
 * buildable offline without bundling npm dependencies.  Pass `textureResolver` to
 * bind DWFx package image resources to Three.js Texture objects in your app layer.
 */
export declare function createThreeGroupFromW3d(pageOrModel: W3dPageData | W3dModelData, THREE: ThreeLikeNamespace, options?: ThreeAdapterOptions): any;
