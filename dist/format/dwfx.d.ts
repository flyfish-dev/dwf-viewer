import type { OpcRelationship } from './opc.js';
import { ZipPackage } from './zip.js';
import { type LoadedDwfDocument } from './document.js';
export declare function openDwfx(zip: ZipPackage): Promise<LoadedDwfDocument>;
export declare function isProbablyDwfx(zip: ZipPackage): boolean;
export declare function getRelationshipById(rels: OpcRelationship[], id: string): OpcRelationship | undefined;
