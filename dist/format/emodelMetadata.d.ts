import type { OpcPackageView } from './opc.js';
import type { W3dModelData } from './document.js';
export interface EModelResourceLike {
    path: string;
    role?: string;
    mediaType?: string;
    title?: string;
    size?: number;
}
export declare function enrichW3dModelFromEModelResources(model: W3dModelData, resources: EModelResourceLike[], opc: OpcPackageView): Promise<void>;
