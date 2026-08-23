import { diag, type Diagnostic } from './types.js';
import { decodeUtf8, parseNumberList } from './util.js';
import { parsePathData } from '../render/xpsPath.js';
import type { W2dPrimitive } from './document.js';
import { isLegacyAsciiDwf, parseLegacyAsciiDwf } from './legacyAsciiDwf.js';

export interface W2dTextParseResult {
  format: 'legacy-ascii-dwf' | 'generic-text';
  primitives: W2dPrimitive[];
  diagnostics: Diagnostic[];
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  version?: string;
  background?: string;
}

export function parseW2dText(bytes: Uint8Array, sourcePath: string): W2dTextParseResult {
  const text = decodeUtf8(bytes);
  if (isLegacyAsciiDwf(text)) {
    return { format: 'legacy-ascii-dwf', ...parseLegacyAsciiDwf(text, sourcePath) };
  }

  const diagnostics: Diagnostic[] = [];
  const primitives: W2dPrimitive[] = [];
  let stroke = '#000000';
  let fill: string | undefined;
  let lineWidth = 1;
  let parsedLines = 0;

  // Accept SVG-ish payloads sometimes embedded by converters/test fixtures.
  if (/<svg[\s>]/i.test(text)) {
    const pathMatches = text.matchAll(/<path\b[^>]*\bd=["']([^"']+)["'][^>]*>/gi);
    for (const m of pathMatches) {
      const tag = m[0]!;
      const d = m[1]!;
      primitives.push({ type: 'path', commands: parsePathData(d), stroke: attr(tag, 'stroke') ?? stroke, fill: attr(tag, 'fill') ?? undefined, lineWidth: Number(attr(tag, 'stroke-width') ?? lineWidth) });
      parsedLines++;
    }
    const polyMatches = text.matchAll(/<(polyline|polygon)\b[^>]*\bpoints=["']([^"']+)["'][^>]*>/gi);
    for (const m of polyMatches) {
      const tag = m[0]!;
      const nums = parseNumberList(m[2]!);
      if (nums.length >= 4) primitives.push({ type: m[1]!.toLowerCase() === 'polygon' ? 'polygon' : 'polyline', points: nums, stroke: attr(tag, 'stroke') ?? stroke, fill: attr(tag, 'fill') ?? undefined, lineWidth: Number(attr(tag, 'stroke-width') ?? lineWidth) } as W2dPrimitive);
      parsedLines++;
    }
  }

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const lower = line.toLowerCase();
    const nums = parseNumberList(line);

    if (/^(color|stroke|pen|wt_color)\b/i.test(line)) {
      stroke = parseColorToken(line) ?? stroke;
      parsedLines++;
      continue;
    }
    if (/^(fill|brush|wt_fill)\b/i.test(line)) {
      fill = parseColorToken(line) ?? fill ?? '#000000';
      parsedLines++;
      continue;
    }
    if (/^(nofill|fillnone)\b/i.test(line)) {
      fill = undefined;
      parsedLines++;
      continue;
    }
    if (/^(linewidth|lineweight|weight|wt_line_weight)\b/i.test(line) && nums.length >= 1) {
      lineWidth = Math.max(0.2, nums[0]!);
      parsedLines++;
      continue;
    }
    if ((/^path\b/i.test(line) || /\bPath\s*Data\b/.test(line)) && /[MmLlCcQqAaZz]/.test(line)) {
      const d = line.replace(/^path\b[:=]?/i, '').replace(/^.*?Data\s*=\s*/i, '').replace(/^['"]|['"]$/g, '');
      primitives.push({ type: 'path', commands: parsePathData(d), stroke, fill, lineWidth });
      parsedLines++;
      continue;
    }
    if (/^(line|wt_line)\b/i.test(line) && nums.length >= 4) {
      primitives.push({ type: 'polyline', points: nums.slice(0, 4), stroke, lineWidth });
      parsedLines++;
      continue;
    }
    if ((/^(polyline|wt_polyline|pline)\b/i.test(line) || /\bPolyline\b/i.test(line)) && nums.length >= 4) {
      primitives.push({ type: 'polyline', points: normalizePointList(nums), stroke, lineWidth });
      parsedLines++;
      continue;
    }
    if ((/^(polygon|wt_polygon)\b/i.test(line) || /\bPolygon\b/i.test(line)) && nums.length >= 6) {
      primitives.push({ type: 'polygon', points: normalizePointList(nums), stroke, fill: fill ?? '#000000', lineWidth });
      parsedLines++;
      continue;
    }
    if (/^(rect|rectangle|wt_rectangle)\b/i.test(line) && nums.length >= 4) {
      primitives.push({ type: 'rect', x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]!, stroke, fill, lineWidth });
      parsedLines++;
      continue;
    }
    if (/^(circle|ellipse)\b/i.test(line) && nums.length >= 3) {
      const [x, y, r] = nums;
      const segments = 72;
      const pts: number[] = [];
      for (let i = 0; i <= segments; i++) {
        const a = Math.PI * 2 * i / segments;
        pts.push(x! + Math.cos(a) * r!, y! + Math.sin(a) * r!);
      }
      primitives.push({ type: 'polygon', points: pts, stroke, fill, lineWidth });
      parsedLines++;
      continue;
    }
    if (/^(text|wt_text)\b/i.test(line) && nums.length >= 2) {
      const x = nums[0]!, y = nums[1]!;
      const size = nums.length >= 3 ? nums[2]! : 12;
      const quoted = line.match(/["']([^"']+)["']/)?.[1];
      const textPayload = quoted ?? line.replace(/^(text|wt_text)\b/i, '').replace(/[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g, '').trim();
      primitives.push({ type: 'text', x, y, size, text: textPayload || 'Text', fill: stroke });
      parsedLines++;
      continue;
    }
    if (lower.includes('wt_') || lower.includes('whip') || lower.includes('dwf')) parsedLines++;
  }

  const bounds = computeBounds(primitives);
  if (primitives.length === 0) {
    diagnostics.push(diag('warning', 'W2D_TEXT_NO_GEOMETRY', `Textual W2D parser did not find supported geometry commands in ${sourcePath}.`, sourcePath));
  } else {
    diagnostics.push(diag('info', 'W2D_TEXT_PARSED', `Parsed ${primitives.length} supported vector primitives from ${sourcePath}.`, sourcePath));
  }
  if (parsedLines === 0) {
    diagnostics.push(diag('warning', 'W2D_TEXT_UNKNOWN_DIALECT', 'The file is textual, but does not look like the supported WHIP/W2D textual subset.', sourcePath));
  }
  return { format: 'generic-text', primitives, diagnostics, bounds };
}

function normalizePointList(nums: number[]): number[] {
  // Some WHIP dumps include a point count before coordinates. Strip it when it matches.
  if (nums.length >= 5 && Number.isInteger(nums[0]) && (nums.length - 1) === nums[0]! * 2) return nums.slice(1);
  return nums;
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1];
}

function parseColorToken(line: string): string | undefined {
  const hex = line.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/i)?.[0];
  if (hex) return hex;
  const nums = parseNumberList(line);
  if (nums.length >= 3) return `rgb(${Math.max(0, Math.min(255, nums[0]!))}, ${Math.max(0, Math.min(255, nums[1]!))}, ${Math.max(0, Math.min(255, nums[2]!))})`;
  const m = line.match(/\b(black|white|red|green|blue|yellow|cyan|magenta|gray|grey)\b/i);
  return m?.[1];
}

function computeBounds(primitives: W2dPrimitive[]): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const p of primitives) {
    if ('points' in p) {
      for (let i = 0; i + 1 < p.points.length; i += 2) add(p.points[i]!, p.points[i + 1]!);
    } else if (p.type === 'rect') {
      add(p.x, p.y); add(p.x + p.width, p.y + p.height);
    } else if (p.type === 'text') {
      add(p.x, p.y); add(p.x + p.text.length * (p.size ?? 12) * 0.6, p.y + (p.size ?? 12));
    } else if (p.type === 'path') {
      for (const c of p.commands) {
        if ('x' in c && 'y' in c && typeof c.x === 'number' && typeof c.y === 'number') add(c.x, c.y);
        if ('x1' in c && 'y1' in c && typeof c.x1 === 'number' && typeof c.y1 === 'number') add(c.x1, c.y1);
        if ('x2' in c && 'y2' in c && typeof c.x2 === 'number' && typeof c.y2 === 'number') add(c.x2, c.y2);
      }
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}
