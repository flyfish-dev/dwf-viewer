import type { LoadedDwfDocument } from '../format/document.js';
import type { PageRenderOptions, RenderStats } from '../format/types.js';
export interface DwfViewerOptions {
    wasmUrl?: string;
    preferWebgl?: boolean;
    preferWasm?: boolean;
    background?: string;
    maxDevicePixelRatio?: number;
    maxCanvasPixels?: number;
    maxGpuCacheBytes?: number;
    maxCachedScenes?: number;
}
export interface LoadOptions extends PageRenderOptions {
    fileName?: string;
}
export declare class DwfViewer {
    readonly root: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    readonly webglCanvas: HTMLCanvasElement;
    readonly pageSelect: HTMLSelectElement;
    readonly status: HTMLSpanElement;
    readonly treePanel: HTMLDivElement;
    private readonly zoomInButton;
    private readonly zoomOutButton;
    private readonly resetButton;
    private doc?;
    private renderer?;
    private pageIndex;
    private zoom;
    private panX;
    private panY;
    private preferWebgl;
    private preferWasm;
    private wasmUrl?;
    private background;
    private maxDevicePixelRatio;
    private maxCanvasPixels;
    private maxGpuCacheBytes?;
    private maxCachedScenes?;
    private drag?;
    private yaw;
    private pitch;
    private pendingRender?;
    private renderRaf;
    private renderSeq;
    private currentDpr;
    constructor(container: HTMLElement, options?: DwfViewerOptions);
    setPreferWebgl(value: boolean): void;
    setPreferWasm(value: boolean): void;
    load(input: ArrayBuffer | Uint8Array | Blob | File, options?: LoadOptions): Promise<void>;
    render(): Promise<RenderStats | undefined>;
    getDocument(): LoadedDwfDocument | undefined;
    fit(): void;
    dispose(): void;
    private requestRender;
    private populatePages;
    private populateModelTree;
    private resizeCanvasToDisplaySize;
    private resetView;
    private zoomAtCenter;
    private zoomAroundPoint;
    private onWheel;
    private onPointerDown;
    private onPointerMove;
    private is3dPage;
    private pagePointAtCanvasPoint;
    private pageMatrixAt;
    private setStatus;
}
