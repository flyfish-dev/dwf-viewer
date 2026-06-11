import { type Diagnostic } from './types.js';
import type { W2dPrimitive } from './document.js';
export interface W2dBinaryParseResult {
    primitives: W2dPrimitive[];
    diagnostics: Diagnostic[];
    bounds?: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
    opcodes: number;
    unsupportedOpcodes: Array<{
        offset: number;
        opcode: number | string;
        message: string;
    }>;
}
export declare function parseW2dBinary(bytes: Uint8Array, sourcePath: string): W2dBinaryParseResult;
