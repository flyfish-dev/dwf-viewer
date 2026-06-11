import { type Matrix2D } from '../render/style.js';
export interface WasmRasterOptions {
    wasmUrl?: string;
}
export declare class WasmRasterBackend {
    private readonly wasmUrl;
    private exports?;
    private fbPtr;
    private fbBytes;
    private width;
    private height;
    constructor(options?: WasmRasterOptions);
    init(): Promise<void>;
    begin(width: number, height: number, backgroundCss?: string): void;
    drawPolyline(points: number[], matrix: Matrix2D, strokeCss: string | undefined, thickness?: number): void;
    drawPolygon(points: number[], matrix: Matrix2D, fillCss: string | undefined): void;
    toImageData(): ImageData;
    private allocF32;
    private ensureMemory;
    private requireExports;
}
