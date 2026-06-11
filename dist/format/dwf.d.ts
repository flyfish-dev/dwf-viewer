import { ZipPackage } from './zip.js';
import { type LoadedDwfDocument } from './document.js';
export declare function isProbablyClassicDwf(zip: ZipPackage): boolean;
export declare function openClassicDwf(zip: ZipPackage): Promise<LoadedDwfDocument>;
