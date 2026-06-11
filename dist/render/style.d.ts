export interface Matrix2D {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}
export declare const IDENTITY: Matrix2D;
export declare function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D;
export declare function transformPoint(m: Matrix2D, x: number, y: number): [number, number];
export declare function parseMatrix(input?: string | null): Matrix2D;
export declare function applyMatrixToContext(ctx: CanvasRenderingContext2D, m: Matrix2D): void;
export declare function parseBrushColor(input?: string | null, opacity?: number): string | undefined;
export declare function colorToRgba32(css: string | undefined, fallback?: number): number;
export declare function packRgba(r: number, g: number, b: number, a: number): number;
