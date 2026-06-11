import type { Diagnostic } from '../format/types.js';
import type { W2dTextPageData } from '../format/document.js';
export interface WebGlW2dRenderOptions {
    zoom?: number;
    panX?: number;
    panY?: number;
    background?: string;
    maxGpuCacheBytes?: number;
    maxCachedScenes?: number;
    compositeToTarget?: boolean;
}
export interface WebGlW2dRenderResult {
    commands: number;
    warnings: Diagnostic[];
    gpuBytes: number;
    vertexCount: number;
    textCount: number;
    cacheHit: boolean;
}
export declare class WebGlW2dBackend {
    private readonly canvas;
    private readonly gl;
    private readonly program;
    private readonly aPos;
    private readonly aColor;
    private readonly uMatrix;
    private readonly uViewport;
    private readonly scenes;
    private gpuBytes;
    private tick;
    constructor(canvas?: HTMLCanvasElement);
    render(page: W2dTextPageData, targetCanvas: HTMLCanvasElement, options?: WebGlW2dRenderOptions): WebGlW2dRenderResult;
    dispose(): void;
    private resize;
    private compileScene;
    private evictIfNeeded;
    private drawTextOverlay;
}
