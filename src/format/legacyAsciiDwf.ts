import { diag, type Diagnostic } from './types.js';
import type { W2dPrimitive } from './document.js';

export interface W2dBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LegacyAsciiDwfParseResult {
  primitives: W2dPrimitive[];
  diagnostics: Diagnostic[];
  bounds?: W2dBounds;
  version?: string;
  background?: string;
}

const MAX_POINT_COUNT = 1_000_000;
const LEGACY_HEADER = /^\uFEFF?\s*\(DWF\s+V\d{2}\.\d{2}(?:\s|\))/i;

/** Returns true for the pre-DWF-6 readable WHIP!/W2D stream produced by tools such as AutoCAD R14. */
export function isLegacyAsciiDwf(text: string): boolean {
  return LEGACY_HEADER.test(text);
}

/**
 * Parses the readable single-byte WHIP!/W2D opcode form used by early DWF files.
 *
 * The format is a stream rather than a line-oriented language: counted point sets can
 * wrap across physical lines, and extended ASCII operands can contain nested parentheses.
 * A cursor-based scanner is therefore required for correct parsing and bounded O(n) work.
 */
export function parseLegacyAsciiDwf(text: string, sourcePath: string): LegacyAsciiDwfParseResult {
  const scanner = new LegacyAsciiScanner(text);
  const diagnostics: Diagnostic[] = [];
  const primitives: W2dPrimitive[] = [];
  const colors: string[] = [];
  const operationCounts = new Map<string, number>();
  const unsupportedOpcodes = new Set<string>();

  let version: string | undefined;
  let background: string | undefined;
  let pendingBackgroundIndex: number | undefined;
  let currentColorIndex: number | undefined = 0;
  let currentColor = '#000000';
  let fill = false;
  let visible = true;
  let lineWidth = 1;
  let markerSize = 1;
  let hiddenGeometry = 0;
  let ended = false;
  let fatal = false;

  const countOperation = (name: string): void => {
    operationCounts.set(name, (operationCounts.get(name) ?? 0) + 1);
  };

  const resolveIndexedColor = (index: number): string | undefined => {
    if (!Number.isInteger(index) || index < 0) return undefined;
    return colors[index];
  };

  const readCountedPoints = (opcode: string): number[] | undefined => {
    const count = scanner.readInteger();
    if (count === undefined || count < 1 || count > MAX_POINT_COUNT) {
      diagnostics.push(diag('error', 'LEGACY_ASCII_DWF_INVALID_POINT_COUNT', `Opcode ${opcode} has an invalid point count at byte ${scanner.position}.`, sourcePath));
      fatal = true;
      return undefined;
    }
    const points = new Array<number>(count * 2);
    for (let i = 0; i < count; i++) {
      const point = scanner.readPoint();
      if (!point) {
        diagnostics.push(diag('error', 'LEGACY_ASCII_DWF_TRUNCATED_POINT_SET', `Opcode ${opcode} ended before point ${i + 1} of ${count} at byte ${scanner.position}.`, sourcePath));
        fatal = true;
        return undefined;
      }
      points[i * 2] = point[0];
      points[i * 2 + 1] = point[1];
    }
    return points;
  };

  while (!scanner.eof && !ended && !fatal) {
    scanner.skipWhitespace();
    if (scanner.eof) break;
    const start = scanner.position;
    const token = scanner.peek();

    if (token === '(') {
      const body = scanner.readExtendedAscii();
      if (body === undefined) {
        diagnostics.push(diag('error', 'LEGACY_ASCII_DWF_UNTERMINATED_EXTENDED_OPCODE', `Unterminated extended ASCII opcode at byte ${start}.`, sourcePath));
        break;
      }
      const extended = splitExtendedOpcode(body);
      if (!extended) continue;
      const name = extended.name.toLowerCase();
      countOperation(`(${extended.name})`);

      if (name === 'dwf') {
        version = extended.operands.match(/\bV\d{2}\.\d{2}\b/i)?.[0]?.toUpperCase();
      } else if (name === 'colormap') {
        const values = parseNumbers(extended.operands);
        const declaredCount = values[0];
        if (declaredCount === undefined || !Number.isInteger(declaredCount) || declaredCount < 1) {
          diagnostics.push(diag('warning', 'LEGACY_ASCII_DWF_INVALID_COLORMAP', 'The legacy DWF ColorMap does not declare a valid color count.', sourcePath));
        } else {
          const availableCount = Math.floor((values.length - 1) / 4);
          const count = Math.min(declaredCount, availableCount);
          colors.length = 0;
          for (let i = 0; i < count; i++) {
            const offset = 1 + i * 4;
            colors.push(toCssColor(values[offset]!, values[offset + 1]!, values[offset + 2]!, values[offset + 3]!));
          }
          if (availableCount < declaredCount) {
            diagnostics.push(diag('warning', 'LEGACY_ASCII_DWF_TRUNCATED_COLORMAP', `ColorMap declares ${declaredCount} colors but contains ${availableCount}.`, sourcePath));
          }
          if (currentColorIndex !== undefined) currentColor = resolveIndexedColor(currentColorIndex) ?? currentColor;
          if (pendingBackgroundIndex !== undefined) background = resolveIndexedColor(pendingBackgroundIndex) ?? background;
        }
      } else if (name === 'background') {
        const values = parseNumbers(extended.operands);
        if (values.length === 1 && Number.isInteger(values[0])) {
          pendingBackgroundIndex = values[0];
          background = resolveIndexedColor(values[0]!) ?? background;
        } else if (values.length >= 3) {
          background = toCssColor(values[0]!, values[1]!, values[2]!, values[3] ?? 255);
          pendingBackgroundIndex = undefined;
        }
      } else if (name === 'color') {
        const values = parseNumbers(extended.operands);
        if (values.length === 1 && Number.isInteger(values[0])) {
          currentColorIndex = values[0];
          currentColor = resolveIndexedColor(values[0]!) ?? currentColor;
        } else if (values.length >= 3) {
          currentColor = toCssColor(values[0]!, values[1]!, values[2]!, values[3] ?? 255);
          currentColorIndex = undefined;
        }
      } else if (name === 'lineweight') {
        const value = parseNumbers(extended.operands)[0];
        if (value !== undefined && Number.isFinite(value)) lineWidth = Math.max(0.2, Math.abs(value));
      } else if (name === 'markersize') {
        const value = parseNumbers(extended.operands)[0];
        if (value !== undefined && Number.isFinite(value)) markerSize = Math.max(1, Math.abs(value));
      } else if (name === 'visibility') {
        const value = extended.operands.trim().toLowerCase();
        const number = parseNumbers(value)[0];
        visible = number !== undefined ? number !== 0 : !/^(?:off|false|hidden)\b/.test(value);
      } else if (name === 'endofdwf') {
        ended = true;
      }
      continue;
    }

    if (!token || !isAsciiLetter(token)) {
      scanner.skipLine();
      continue;
    }

    scanner.advance();
    countOperation(token);
    switch (token) {
      case 'C': {
        const index = scanner.readInteger();
        if (index === undefined) {
          diagnostics.push(diag('error', 'LEGACY_ASCII_DWF_INVALID_COLOR_INDEX', `Color opcode C is missing its palette index at byte ${scanner.position}.`, sourcePath));
          fatal = true;
          break;
        }
        currentColorIndex = index;
        const resolved = resolveIndexedColor(index);
        if (resolved) currentColor = resolved;
        break;
      }
      case 'F':
        fill = true;
        break;
      case 'f':
        fill = false;
        break;
      case 'V':
        visible = true;
        break;
      case 'v':
        visible = false;
        break;
      case 'L': {
        const first = scanner.readPoint();
        const second = scanner.readPoint();
        if (!first || !second) {
          diagnostics.push(diag('error', 'LEGACY_ASCII_DWF_TRUNCATED_LINE', `Line opcode L is missing coordinates at byte ${scanner.position}.`, sourcePath));
          fatal = true;
          break;
        }
        if (visible) {
          primitives.push({ type: 'polyline', points: [first[0], first[1], second[0], second[1]], stroke: currentColor, lineWidth });
        } else {
          hiddenGeometry++;
        }
        break;
      }
      case 'P': {
        const points = readCountedPoints(token);
        if (!points) break;
        if (!visible) {
          hiddenGeometry++;
        } else if (fill && points.length >= 6) {
          primitives.push({ type: 'polygon', points, fill: currentColor });
        } else {
          primitives.push({ type: 'polyline', points, stroke: currentColor, lineWidth });
        }
        break;
      }
      case 'T': {
        const points = readCountedPoints(token);
        if (!points) break;
        if (!visible) {
          hiddenGeometry++;
          break;
        }
        appendTriangleStrip(primitives, points, currentColor);
        break;
      }
      case 'M': {
        const points = readCountedPoints(token);
        if (!points) break;
        if (!visible) {
          hiddenGeometry++;
          break;
        }
        const size = Math.max(1, markerSize, lineWidth);
        for (let i = 0; i + 1 < points.length; i += 2) {
          primitives.push({
            type: 'rect',
            x: points[i]! - size / 2,
            y: points[i + 1]! - size / 2,
            width: size,
            height: size,
            fill: currentColor
          });
        }
        break;
      }
      default:
        unsupportedOpcodes.add(printableOpcode(token));
        // Readable WHIP! writers put one opcode on a physical line. Skipping an
        // unsupported operand prevents its numeric payload from being mistaken for opcodes.
        scanner.skipLine();
        break;
    }

    if (scanner.position <= start) scanner.advance();
  }

  const bounds = computeBounds(primitives);
  const geometryPrimitiveCount = primitives.length;
  const versionLabel = version ?? 'legacy ASCII DWF';
  if (geometryPrimitiveCount === 0) {
    diagnostics.push(diag('warning', 'LEGACY_ASCII_DWF_NO_GEOMETRY', `${versionLabel} contained no supported visible geometry.`, sourcePath));
  } else {
    const counts = ['L', 'P', 'T', 'M']
      .map(opcode => `${opcode}=${operationCounts.get(opcode) ?? 0}`)
      .join(', ');
    const hiddenText = hiddenGeometry > 0 ? `; skipped ${hiddenGeometry} hidden geometry operation(s)` : '';
    diagnostics.push(diag('info', 'LEGACY_ASCII_DWF_PARSED', `Parsed ${versionLabel} readable WHIP!/W2D stream (${counts}) into ${geometryPrimitiveCount} geometry primitive(s)${hiddenText}.`, sourcePath));
  }
  if (unsupportedOpcodes.size > 0) {
    diagnostics.push(diag('warning', 'LEGACY_ASCII_DWF_UNSUPPORTED_OPCODES', `Ignored unsupported readable WHIP!/W2D opcode(s): ${Array.from(unsupportedOpcodes).sort().join(', ')}.`, sourcePath));
  }
  if (!ended) {
    diagnostics.push(diag('warning', 'LEGACY_ASCII_DWF_MISSING_END', 'The readable WHIP!/W2D stream did not contain a complete (EndOfDWF) marker.', sourcePath));
  }

  // The existing W2D render contract does not carry a page-background field. Emit the
  // declared DWF backdrop as the first primitive so Canvas, WASM, and WebGL backends all
  // preserve the source appearance without backend-specific special cases.
  if (background && bounds) {
    primitives.unshift({
      type: 'rect',
      x: bounds.minX,
      y: bounds.minY,
      width: Math.max(1, bounds.maxX - bounds.minX),
      height: Math.max(1, bounds.maxY - bounds.minY),
      fill: background
    });
  }

  return { primitives, diagnostics, bounds, version, background };
}

function appendTriangleStrip(primitives: W2dPrimitive[], points: number[], color: string): void {
  const pointCount = Math.floor(points.length / 2);
  for (let i = 2; i < pointCount; i++) {
    const firstIndex = i % 2 === 0 ? i - 2 : i - 1;
    const secondIndex = i % 2 === 0 ? i - 1 : i - 2;
    const ax = points[firstIndex * 2]!;
    const ay = points[firstIndex * 2 + 1]!;
    const bx = points[secondIndex * 2]!;
    const by = points[secondIndex * 2 + 1]!;
    const cx = points[i * 2]!;
    const cy = points[i * 2 + 1]!;
    // Degenerate vertices are legal separators in triangle strips and must not emit geometry.
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) continue;
    primitives.push({ type: 'polygon', points: [ax, ay, bx, by, cx, cy], fill: color });
  }
}

function computeBounds(primitives: W2dPrimitive[]): W2dBounds | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const primitive of primitives) {
    if ('points' in primitive) {
      for (let i = 0; i + 1 < primitive.points.length; i += 2) add(primitive.points[i]!, primitive.points[i + 1]!);
    } else if (primitive.type === 'rect') {
      add(primitive.x, primitive.y);
      add(primitive.x + primitive.width, primitive.y + primitive.height);
    } else if (primitive.type === 'text') {
      const size = primitive.size ?? 12;
      add(primitive.x, primitive.y);
      add(primitive.x + primitive.text.length * size * 0.6, primitive.y + size);
    } else if (primitive.type === 'path') {
      for (const command of primitive.commands) {
        if ('x' in command && 'y' in command && typeof command.x === 'number' && typeof command.y === 'number') add(command.x, command.y);
        if ('x1' in command && 'y1' in command && typeof command.x1 === 'number' && typeof command.y1 === 'number') add(command.x1, command.y1);
        if ('x2' in command && 'y2' in command && typeof command.x2 === 'number' && typeof command.y2 === 'number') add(command.x2, command.y2);
      }
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}

function splitExtendedOpcode(body: string): { name: string; operands: string } | undefined {
  const trimmed = body.trimStart();
  const match = trimmed.match(/^([^\s()]+)/);
  if (!match?.[1]) return undefined;
  return { name: match[1], operands: trimmed.slice(match[1].length) };
}

function parseNumbers(value: string): number[] {
  return Array.from(value.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g), match => Number(match[0]));
}

function toCssColor(red: number, green: number, blue: number, alpha = 255): string {
  const r = clampByte(red);
  const g = clampByte(green);
  const b = clampByte(blue);
  const a = clampByte(alpha);
  if (a === 255) return `rgb(${r}, ${g}, ${b})`;
  const normalized = Number((a / 255).toFixed(4));
  return `rgba(${r}, ${g}, ${b}, ${normalized})`;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function isAsciiLetter(value: string): boolean {
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function printableOpcode(value: string): string {
  const code = value.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e ? value : `0x${code.toString(16).padStart(2, '0')}`;
}

class LegacyAsciiScanner {
  position = 0;

  constructor(private readonly source: string) {}

  get eof(): boolean {
    return this.position >= this.source.length;
  }

  peek(): string | undefined {
    return this.source[this.position];
  }

  advance(): void {
    if (!this.eof) this.position++;
  }

  skipWhitespace(): void {
    while (!this.eof) {
      const code = this.source.charCodeAt(this.position);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) break;
      this.position++;
    }
  }

  skipLine(): void {
    while (!this.eof) {
      const code = this.source.charCodeAt(this.position++);
      if (code === 0x0a) break;
    }
  }

  readInteger(): number | undefined {
    const value = this.readNumber();
    return value !== undefined && Number.isInteger(value) ? value : undefined;
  }

  readPoint(): [number, number] | undefined {
    const start = this.position;
    const x = this.readNumber();
    if (x === undefined) {
      this.position = start;
      return undefined;
    }
    this.skipWhitespace();
    if (this.source[this.position] !== ',') {
      this.position = start;
      return undefined;
    }
    this.position++;
    const y = this.readNumber();
    if (y === undefined) {
      this.position = start;
      return undefined;
    }
    return [x, y];
  }

  readNumber(): number | undefined {
    this.skipWhitespace();
    const start = this.position;
    if (this.source[this.position] === '+' || this.source[this.position] === '-') this.position++;

    let digits = 0;
    while (!this.eof && isDigitCode(this.source.charCodeAt(this.position))) {
      this.position++;
      digits++;
    }
    if (this.source[this.position] === '.') {
      this.position++;
      while (!this.eof && isDigitCode(this.source.charCodeAt(this.position))) {
        this.position++;
        digits++;
      }
    }
    if (digits === 0) {
      this.position = start;
      return undefined;
    }

    if (this.source[this.position] === 'e' || this.source[this.position] === 'E') {
      const exponentStart = this.position;
      this.position++;
      if (this.source[this.position] === '+' || this.source[this.position] === '-') this.position++;
      let exponentDigits = 0;
      while (!this.eof && isDigitCode(this.source.charCodeAt(this.position))) {
        this.position++;
        exponentDigits++;
      }
      if (exponentDigits === 0) this.position = exponentStart;
    }

    const value = Number(this.source.slice(start, this.position));
    if (!Number.isFinite(value)) {
      this.position = start;
      return undefined;
    }
    return value;
  }

  readExtendedAscii(): string | undefined {
    if (this.source[this.position] !== '(') return undefined;
    const start = this.position++;
    let depth = 1;
    let quote: string | undefined;
    let escaped = false;

    while (!this.eof) {
      const value = this.source[this.position++]!;
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (value === '\\') {
          escaped = true;
        } else if (value === quote) {
          quote = undefined;
        }
        continue;
      }
      if (value === "'" || value === '"') {
        quote = value;
      } else if (value === '(') {
        depth++;
      } else if (value === ')') {
        depth--;
        if (depth === 0) return this.source.slice(start + 1, this.position - 1);
      }
    }
    return undefined;
  }
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}
