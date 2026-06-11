import { type RenderStats } from '../format/types.js';
import type { LoadedDwfDocument } from '../format/document.js';
export interface GenericRenderOptions {
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
    yaw?: number;
    pitch?: number;
}
export declare class PageRenderer {
    private readonly document;
    private xps?;
    private w2d?;
    private w3d?;
    constructor(document: LoadedDwfDocument);
    render(pageIndex: number, canvas: HTMLCanvasElement, options?: GenericRenderOptions): Promise<RenderStats>;
    dispose(): void;
    private renderImage;
    private renderUnsupported;
}
