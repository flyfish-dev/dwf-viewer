import { diag, type DwfDocument, type OpenOptions } from './types.js';
import { looksLikeZip, ZipPackage } from './zip.js';
import { isProbablyDwfx, openDwfx } from './dwfx.js';
import { isProbablyClassicDwf, openClassicDwf } from './dwf.js';
import { bytesLookTextual } from './util.js';
import { parseW2dText } from './w2dText.js';
import { makeLoadedDocument, type LoadedDwfDocument, type PageData, type UnsupportedPageData, type W2dTextPageData } from './document.js';

export async function openDwfDocument(input: ArrayBuffer | Uint8Array | Blob | File, options: OpenOptions = {}): Promise<LoadedDwfDocument> {
  const bytes = await toBytes(input);
  const fileName = options.fileName ?? ((input instanceof File) ? input.name : undefined) ?? 'document.dwf';
  if (looksLikeZip(bytes)) {
    const zip = ZipPackage.open(bytes, options.inflater);
    if (isProbablyDwfx(zip)) return await openDwfx(zip);
    if (isProbablyClassicDwf(zip)) return await openClassicDwf(zip);
    // Mixed or unknown ZIP: try DWFx first if fixed pages exist, then classic discovery.
    if (zip.entries.some(e => /\.fpage$/i.test(e.name))) return await openDwfx(zip);
    return await openClassicDwf(zip);
  }

  if (bytesLookTextual(bytes)) {
    const parsed = parseW2dText(bytes, fileName);
    const isLegacyAsciiDwf = parsed.format === 'legacy-ascii-dwf';
    const pageData: PageData[] = [{
      id: 'page-1',
      name: fileName,
      kind: 'w2d-text',
      width: parsed.bounds ? Math.max(1, parsed.bounds.maxX - parsed.bounds.minX) : 1000,
      height: parsed.bounds ? Math.max(1, parsed.bounds.maxY - parsed.bounds.minY) : 1000,
      sourcePath: fileName,
      primitives: parsed.primitives,
      bounds: parsed.bounds,
      diagnostics: parsed.diagnostics
    } as W2dTextPageData];
    const base: DwfDocument = {
      kind: isLegacyAsciiDwf ? 'dwf' : 'unknown',
      pages: [],
      resources: [{ path: fileName, mediaType: isLegacyAsciiDwf ? 'model/vnd.dwf' : 'text/plain', size: bytes.byteLength }],
      diagnostics: isLegacyAsciiDwf
        ? [diag('info', 'LEGACY_ASCII_DWF_MODE', `Opened ${parsed.version ?? 'legacy'} readable WHIP!/W2D stream as a classic DWF document.`, fileName)]
        : [diag('warning', 'RAW_TEXT_W2D_MODE', 'Input is not a DWF ZIP package; opened it as a textual W2D-like vector stream.', fileName)],
      packageEntries: [fileName]
    };
    return makeLoadedDocument(base, pageData);
  }

  const unsupported: UnsupportedPageData = {
    id: 'unsupported-raw',
    name: fileName,
    kind: 'unsupported',
    width: 1000,
    height: 1000,
    sourcePath: fileName,
    reason: 'Input is neither a ZIP-based DWF/DWFx package nor a supported textual W2D stream.',
    diagnostics: [diag('error', 'UNSUPPORTED_RAW_FORMAT', 'Unsupported raw DWF input. DWF 6+/DWFx ZIP packages or readable legacy WHIP!/W2D streams are required for this build.', fileName)]
  };
  const base: DwfDocument = {
    kind: 'unknown',
    pages: [],
    resources: [{ path: fileName, size: bytes.byteLength }],
    diagnostics: unsupported.diagnostics,
    packageEntries: [fileName]
  };
  return makeLoadedDocument(base, [unsupported]);
}

async function toBytes(input: ArrayBuffer | Uint8Array | Blob | File): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}
