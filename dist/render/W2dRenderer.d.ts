import { type RenderStats } from '../format/types.js';
import type { W2dTextPageData } from '../format/document.js';
export interface W2dRenderOptions {
    zoom?: number;
    panX?: number;
    panY?: number;
    preferWebgl?: boolean;
    preferWasm?: boolean;
    wasmUrl?: string;
    background?: string;
    maxGpuCacheBytes?: number;
    maxCachedScenes?: number;
    webglCanvas?: HTMLCanvasElement;
}
export declare class W2dRenderer {
    private wasm?;
    private webgl?;
    private webglCanvas?;
    render(page: W2dTextPageData, canvas: HTMLCanvasElement, options?: W2dRenderOptions): Promise<RenderStats>;
    dispose(): void;
    private getWebGlBackend;
    private drawPrimitiveCanvas;
    private drawPrimitiveWasm;
}
