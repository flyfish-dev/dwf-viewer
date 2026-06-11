export type DiagnosticLevel = 'info' | 'warning' | 'error';
export interface Diagnostic {
    level: DiagnosticLevel;
    code: string;
    message: string;
    source?: string;
}
export interface ResourceRef {
    path: string;
    mediaType?: string;
    role?: string;
    size?: number;
}
export interface RenderViewport {
    width: number;
    height: number;
    scale: number;
    offsetX: number;
    offsetY: number;
    devicePixelRatio: number;
}
export type PageKind = 'xps-fixed-page' | 'w2d-text' | 'image' | 'w3d-model' | 'unsupported';
export interface RenderablePage {
    id: string;
    name: string;
    kind: PageKind;
    width: number;
    height: number;
    sourcePath?: string;
    diagnostics: Diagnostic[];
}
export interface DwfDocument {
    kind: 'dwf' | 'dwfx' | 'zip-dwf' | 'unknown';
    pages: RenderablePage[];
    resources: ResourceRef[];
    diagnostics: Diagnostic[];
    packageEntries: string[];
}
export interface OpenOptions {
    fileName?: string;
    inflater?: InflateProvider;
}
export interface InflateProvider {
    inflateRaw(data: Uint8Array): Promise<Uint8Array>;
}
export interface PageRenderOptions {
    pageIndex?: number;
    preferWebgl?: boolean;
    preferWasm?: boolean;
    wasmUrl?: string;
    background?: string;
    maxGpuCacheBytes?: number;
    maxCachedScenes?: number;
}
export interface RenderStats {
    backend: 'canvas2d' | 'wasm-raster' | 'webgl' | 'threejs-webgl' | 'image' | 'unsupported';
    commands: number;
    warnings: Diagnostic[];
}
export declare function diag(level: DiagnosticLevel, code: string, message: string, source?: string): Diagnostic;
export declare function actionableDiagnostics(diagnostics: readonly Diagnostic[] | undefined): Diagnostic[];
