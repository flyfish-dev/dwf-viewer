export type PathCommand = {
    type: 'M';
    x: number;
    y: number;
} | {
    type: 'L';
    x: number;
    y: number;
} | {
    type: 'C';
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    x: number;
    y: number;
} | {
    type: 'Q';
    x1: number;
    y1: number;
    x: number;
    y: number;
} | {
    type: 'A';
    rx: number;
    ry: number;
    rotation: number;
    largeArc: boolean;
    sweep: boolean;
    x: number;
    y: number;
} | {
    type: 'Z';
};
export interface FlattenedSubpath {
    points: number[];
    closed: boolean;
}
export declare function parsePathData(data: string): PathCommand[];
export declare function applyPathToCanvas(ctx: CanvasRenderingContext2D, commands: PathCommand[]): void;
export declare function flattenPath(commands: PathCommand[], tolerance?: number): FlattenedSubpath[];
