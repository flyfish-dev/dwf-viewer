import type { ResourceRef } from './types.js';
import { ZipPackage } from './zip.js';
export interface OpcRelationship {
    id: string;
    type: string;
    target: string;
    targetMode?: string;
    source: string;
    resolvedTarget: string;
}
export interface ContentTypeOverride {
    partName: string;
    contentType: string;
}
export interface OpcPackageView {
    zip: ZipPackage;
    contentTypes: Map<string, string>;
    defaults: Map<string, string>;
    overrides: ContentTypeOverride[];
    relationships: Map<string, OpcRelationship[]>;
    resources: ResourceRef[];
    readText(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    getContentType(path: string): string | undefined;
    getRelationships(sourcePath?: string): Promise<OpcRelationship[]>;
}
export declare function createOpcView(zip: ZipPackage): Promise<OpcPackageView>;
export declare function relationshipPartName(sourcePath: string): string;
