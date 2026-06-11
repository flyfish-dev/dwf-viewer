function getDecompressionStreamCtor() {
    return globalThis.DecompressionStream;
}
export class BrowserInflateProvider {
    async inflateRaw(data) {
        const DS = getDecompressionStreamCtor();
        if (!DS) {
            throw new Error('This browser does not expose DecompressionStream. Provide a custom InflateProvider, or pre-bundle a WASM/JS inflater.');
        }
        try {
            return await decompressWithFormat(data, 'deflate-raw', DS);
        }
        catch (rawError) {
            try {
                return await decompressWithFormat(data, 'deflate', DS);
            }
            catch {
                throw rawError instanceof Error ? rawError : new Error(String(rawError));
            }
        }
    }
}
async function decompressWithFormat(data, format, DS) {
    const blobStream = new Blob([data]).stream();
    const decompressedStream = blobStream.pipeThrough(new DS(format));
    const ab = await new Response(decompressedStream).arrayBuffer();
    return new Uint8Array(ab);
}
