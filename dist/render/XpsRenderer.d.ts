import { type RenderStats } from '../format/types.js';
import type { LoadedDwfDocument, XpsPageData } from '../format/document.js';
export interface XpsRenderOptions {
    zoom?: number;
    panX?: number;
    panY?: number;
    preferWasm?: boolean;
    wasmUrl?: string;
    background?: string;
}
export declare class XpsRenderer {
    private readonly document;
    private wasm?;
    constructor(document: LoadedDwfDocument);
    render(page: XpsPageData, canvas: HTMLCanvasElement, options?: XpsRenderOptions): Promise<RenderStats>;
    private renderElementToCanvas;
    private renderElementToWasm;
    private drawImageResource;
    private drawImageBrush;
}
