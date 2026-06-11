import type { InflateProvider } from './types.js';
export declare class BrowserInflateProvider implements InflateProvider {
    inflateRaw(data: Uint8Array): Promise<Uint8Array>;
}
