import { BrowserInflateProvider } from './inflate.js';
import { decodeUtf8, normalizePath } from './util.js';
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
export class ZipPackage {
    constructor(bytes, entries, archiveBase, inflater) {
        this.entryMap = new Map();
        this.cache = new Map();
        this.bytes = bytes;
        this.entries = entries;
        this.archiveBase = archiveBase;
        this.inflater = inflater ?? new BrowserInflateProvider();
        for (const e of entries)
            this.entryMap.set(normalizePath(e.name), e);
    }
    static open(bytes, inflater) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const eocdOffset = findEocd(view);
        if (eocdOffset < 0)
            throw new Error('ZIP end-of-central-directory record was not found. This is not a DWF 6+/DWFx ZIP package.');
        const diskNo = u16(view, eocdOffset + 4);
        const cdDiskNo = u16(view, eocdOffset + 6);
        if (diskNo !== 0 || cdDiskNo !== 0)
            throw new Error('Multi-disk ZIP archives are not supported.');
        const entryCount = u16(view, eocdOffset + 10);
        const centralSize = u32(view, eocdOffset + 12);
        const centralOffset = u32(view, eocdOffset + 16);
        // ZIP offsets are relative to the beginning of the ZIP archive. DWF files may prepend a textual
        // DWF header before the actual PK stream, so derive the base by locating the central directory.
        let archiveBase = 0;
        let centralAbs = centralOffset;
        if (u32(view, centralAbs) !== SIG_CENTRAL) {
            const maxShift = Math.max(0, eocdOffset - centralSize - 1024 * 1024);
            let found = -1;
            for (let p = eocdOffset - centralSize; p >= maxShift; p--) {
                if (p >= 0 && u32(view, p) === SIG_CENTRAL) {
                    found = p;
                    break;
                }
            }
            if (found < 0)
                throw new Error('ZIP central directory could not be located.');
            centralAbs = found;
            archiveBase = centralAbs - centralOffset;
        }
        const entries = [];
        let ptr = centralAbs;
        for (let i = 0; i < entryCount; i++) {
            if (u32(view, ptr) !== SIG_CENTRAL)
                throw new Error(`Bad central directory signature at ${ptr}.`);
            const flags = u16(view, ptr + 8);
            const method = u16(view, ptr + 10);
            const lastModTime = u16(view, ptr + 12);
            const lastModDate = u16(view, ptr + 14);
            const crc32 = u32(view, ptr + 16);
            const compressedSize = u32(view, ptr + 20);
            const uncompressedSize = u32(view, ptr + 24);
            const nameLen = u16(view, ptr + 28);
            const extraLen = u16(view, ptr + 30);
            const commentLen = u16(view, ptr + 32);
            const localHeaderOffset = u32(view, ptr + 42);
            const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
            const commentBytes = bytes.subarray(ptr + 46 + nameLen + extraLen, ptr + 46 + nameLen + extraLen + commentLen);
            const name = normalizePath(decodeFileName(nameBytes, flags));
            const comment = decodeFileName(commentBytes, flags);
            if (!name.endsWith('/')) {
                entries.push({ name, compressedSize, uncompressedSize, compressionMethod: method, crc32, localHeaderOffset, centralHeaderOffset: ptr - archiveBase, flags, lastModTime, lastModDate, comment });
            }
            ptr += 46 + nameLen + extraLen + commentLen;
        }
        return new ZipPackage(bytes, entries, archiveBase, inflater);
    }
    has(name) {
        return this.entryMap.has(normalizePath(name));
    }
    get(name) {
        return this.entryMap.get(normalizePath(name));
    }
    find(predicate) {
        return this.entries.find(predicate);
    }
    findAll(predicate) {
        return this.entries.filter(predicate);
    }
    async read(entryOrName) {
        const entry = typeof entryOrName === 'string' ? this.get(entryOrName) : entryOrName;
        if (!entry)
            throw new Error(`ZIP entry not found: ${entryOrName}`);
        const cached = this.cache.get(entry.name);
        if (cached)
            return cached;
        const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
        const localAbs = this.archiveBase + entry.localHeaderOffset;
        if (u32(view, localAbs) !== SIG_LOCAL)
            throw new Error(`Bad local header signature for ${entry.name}.`);
        const nameLen = u16(view, localAbs + 26);
        const extraLen = u16(view, localAbs + 28);
        const dataStart = localAbs + 30 + nameLen + extraLen;
        const compressed = this.bytes.subarray(dataStart, dataStart + entry.compressedSize);
        let out;
        if (entry.compressionMethod === 0)
            out = compressed.slice();
        else if (entry.compressionMethod === 8)
            out = await this.inflater.inflateRaw(compressed);
        else
            throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}.`);
        if (entry.uncompressedSize !== 0 && out.byteLength !== entry.uncompressedSize) {
            // Some producers write zero or ZIP64 placeholders; only enforce when central directory has a normal size.
            if (entry.uncompressedSize < 0xffffffff) {
                throw new Error(`ZIP entry size mismatch for ${entry.name}: expected ${entry.uncompressedSize}, got ${out.byteLength}.`);
            }
        }
        this.cache.set(entry.name, out);
        return out;
    }
}
export function looksLikeZip(bytes) {
    if (bytes.byteLength < 22)
        return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (u32(view, 0) === SIG_LOCAL)
        return true;
    return findEocd(view) >= 0;
}
function findEocd(view) {
    const min = Math.max(0, view.byteLength - 0xffff - 22);
    for (let p = view.byteLength - 22; p >= min; p--) {
        if (u32(view, p) === SIG_EOCD)
            return p;
    }
    return -1;
}
function decodeFileName(bytes, flags) {
    // Bit 11 indicates UTF-8. For legacy DWF names, ASCII-compatible decoding is usually enough.
    if ((flags & (1 << 11)) !== 0)
        return decodeUtf8(bytes);
    return Array.from(bytes, b => String.fromCharCode(b)).join('');
}
function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }
