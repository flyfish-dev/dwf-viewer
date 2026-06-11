import type { Matrix2D } from './style.js';
import type { W2dTextPageData } from '../format/document.js';
export interface FitOptions {
    canvasWidth: number;
    canvasHeight: number;
    pageWidth: number;
    pageHeight: number;
    zoom?: number;
    panX?: number;
    panY?: number;
    margin?: number;
    sourceMinX?: number;
    sourceMinY?: number;
}
export declare function fitPageMatrix(opts: FitOptions): Matrix2D;
export declare function matrixForW2d(page: W2dTextPageData, canvasWidth: number, canvasHeight: number, zoom?: number, panX?: number, panY?: number): Matrix2D;
