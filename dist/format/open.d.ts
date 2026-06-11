import { type OpenOptions } from './types.js';
import { type LoadedDwfDocument } from './document.js';
export declare function openDwfDocument(input: ArrayBuffer | Uint8Array | Blob | File, options?: OpenOptions): Promise<LoadedDwfDocument>;
