import { type RenderStats } from '../format/types.js';
import type { W3dPageData } from '../format/document.js';
import type { GenericRenderOptions } from './PageRenderer.js';
export interface W3dCameraOptions {
    yaw?: number;
    pitch?: number;
    zoom?: number;
    panX?: number;
    panY?: number;
}
export declare class ThreeW3dRenderer {
    private gl?;
    private program?;
    private edgeProgram?;
    private cache;
    private currentCanvas?;
    render(page: W3dPageData, overlayCanvas: HTMLCanvasElement, options?: GenericRenderOptions): Promise<RenderStats>;
    dispose(): void;
    private ensureContext;
    private ensureProgram;
    private ensureEdgeProgram;
    private evictScenes;
    private ensureScene;
}
