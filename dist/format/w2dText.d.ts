import { type Diagnostic } from './types.js';
import type { W2dPrimitive } from './document.js';
export interface W2dTextParseResult {
    primitives: W2dPrimitive[];
    diagnostics: Diagnostic[];
    bounds?: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
}
export declare function parseW2dText(bytes: Uint8Array, sourcePath: string): W2dTextParseResult;
