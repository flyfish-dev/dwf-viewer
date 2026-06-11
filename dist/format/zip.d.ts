import type { InflateProvider } from './types.js';
export interface ZipEntry {
    name: string;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    crc32: number;
    localHeaderOffset: number;
    centralHeaderOffset: number;
    flags: number;
    lastModTime: number;
    lastModDate: number;
    comment: string;
}
export declare class ZipPackage {
    readonly entries: ZipEntry[];
    readonly entryMap: Map<string, ZipEntry>;
    readonly archiveBase: number;
    private readonly bytes;
    private readonly inflater;
    private readonly cache;
    private constructor();
    static open(bytes: Uint8Array, inflater?: InflateProvider): ZipPackage;
    has(name: string): boolean;
    get(name: string): ZipEntry | undefined;
    find(predicate: (entry: ZipEntry) => boolean): ZipEntry | undefined;
    findAll(predicate: (entry: ZipEntry) => boolean): ZipEntry[];
    read(entryOrName: ZipEntry | string): Promise<Uint8Array>;
}
export declare function looksLikeZip(bytes: Uint8Array): boolean;
