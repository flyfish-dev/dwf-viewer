import type { PageData, W2dPrimitive } from '../format/document.js';

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const pageCache = new WeakMap<PageData, Map<string, PageData>>();

const NAMED_COLORS: Record<string, RgbaColor> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 }
};

/**
 * Normalizes the supported fixed color forms to one renderer-safe CSS value.
 * Empty or non-color values disable the monochrome override.
 */
export function normalizeMonochromeColor(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = parseColor(value);
  return parsed ? toCssColor(parsed) : undefined;
}

/**
 * Returns a page view with vector/text/material colors replaced while keeping
 * geometry, line weights, source diagnostics, images and source objects intact.
 */
export function createMonochromePage(page: PageData, color: string): PageData {
  const normalized = normalizeMonochromeColor(color);
  if (!normalized) return page;
  if (page.kind !== 'w2d-text' && page.kind !== 'w3d-model') return page;

  let colors = pageCache.get(page);
  if (!colors) {
    colors = new Map<string, PageData>();
    pageCache.set(page, colors);
  }
  const cached = colors.get(normalized);
  if (cached) return cached;

  let transformed: PageData;
  if (page.kind === 'w2d-text') {
    transformed = {
      ...page,
      primitives: page.primitives.map((primitive) => monochromePrimitive(primitive, normalized))
    };
  } else {
    const target = parseColor(normalized) ?? NAMED_COLORS.black!;
    const rgb = [target.r / 255, target.g / 255, target.b / 255] as [number, number, number];
    transformed = {
      ...page,
      model: {
        ...page.model,
        meshes: page.model.meshes.map((mesh) => ({
          ...mesh,
          color: [rgb[0], rgb[1], rgb[2]]
        })),
        materials: page.model.materials?.map((material) => ({
          ...material,
          color: [rgb[0], rgb[1], rgb[2]]
        }))
      }
    };
  }

  colors.set(normalized, transformed);
  return transformed;
}

/**
 * Rewrites only direct XPS color attributes. Resource references and image
 * brushes are left untouched; referenced SolidColorBrush/GradientStop colors
 * are rewritten when their XML resource part is read.
 */
export function applyXpsMonochromeXml(xml: string, color: string): string {
  const normalized = normalizeMonochromeColor(color);
  if (!normalized || !xml) return xml;
  return xml.replace(
    /(\b(?:Fill|Stroke|Color)\s*=\s*)(["'])([^"']*)\2/gi,
    (match, prefix: string, quote: string, source: string) => {
      if (!parseColor(source)) return match;
      return `${prefix}${quote}${monochromeColorWithAlpha(normalized, source)}${quote}`;
    }
  );
}

/** Preserves source brush alpha and combines it with an optional target alpha. */
export function monochromeColorWithAlpha(color: string, sourceColor?: string): string {
  const target = parseColor(color) ?? NAMED_COLORS.black!;
  const source = sourceColor ? parseColor(sourceColor) : undefined;
  return toCssColor({
    r: target.r,
    g: target.g,
    b: target.b,
    a: clamp01(target.a * (source?.a ?? 1))
  });
}

function monochromePrimitive(primitive: W2dPrimitive, color: string): W2dPrimitive {
  const next = { ...primitive } as W2dPrimitive;
  if (primitive.stroke !== undefined) next.stroke = monochromeColorWithAlpha(color, primitive.stroke);
  if (primitive.fill !== undefined) next.fill = monochromeColorWithAlpha(color, primitive.fill);

  // W2D polylines and text have an implicit black fallback in the renderer.
  // Materialize that fallback so a white/custom monochrome target works too.
  if (primitive.type === 'polyline' && primitive.stroke === undefined) next.stroke = color;
  if (primitive.type === 'text' && primitive.stroke === undefined && primitive.fill === undefined) next.fill = color;
  return next;
}

function parseColor(value: string): RgbaColor | undefined {
  const source = value.trim();
  if (!source) return undefined;
  const named = NAMED_COLORS[source.toLowerCase()];
  if (named) return { ...named };

  if (/^#[0-9a-f]{3}$/i.test(source)) {
    return {
      r: parseInt(source[1]! + source[1]!, 16),
      g: parseInt(source[2]! + source[2]!, 16),
      b: parseInt(source[3]! + source[3]!, 16),
      a: 1
    };
  }
  if (/^#[0-9a-f]{4}$/i.test(source)) {
    return {
      r: parseInt(source[1]! + source[1]!, 16),
      g: parseInt(source[2]! + source[2]!, 16),
      b: parseInt(source[3]! + source[3]!, 16),
      a: parseInt(source[4]! + source[4]!, 16) / 255
    };
  }
  if (/^#[0-9a-f]{6}$/i.test(source)) {
    return {
      r: parseInt(source.slice(1, 3), 16),
      g: parseInt(source.slice(3, 5), 16),
      b: parseInt(source.slice(5, 7), 16),
      a: 1
    };
  }
  if (/^#[0-9a-f]{8}$/i.test(source)) {
    // FixedPage/XPS stores eight-digit colors as #AARRGGBB.
    return {
      r: parseInt(source.slice(3, 5), 16),
      g: parseInt(source.slice(5, 7), 16),
      b: parseInt(source.slice(7, 9), 16),
      a: parseInt(source.slice(1, 3), 16) / 255
    };
  }

  if (/^sc#/i.test(source)) {
    const values = source.slice(3).split(',').map((item) => Number(item.trim()));
    if (values.length === 3 && values.every(Number.isFinite)) {
      return { r: values[0]! * 255, g: values[1]! * 255, b: values[2]! * 255, a: 1 };
    }
    if (values.length === 4 && values.every(Number.isFinite)) {
      return { r: values[1]! * 255, g: values[2]! * 255, b: values[3]! * 255, a: clamp01(values[0]!) };
    }
  }

  const rgb = source.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1]!.split(',').map((item) => item.trim());
    if (parts.length === 3 || parts.length === 4) {
      const channels = parts.slice(0, 3).map(parseChannel);
      const alpha = parts[3] === undefined ? 1 : parseAlpha(parts[3]);
      if (channels.every((item): item is number => item !== undefined) && alpha !== undefined) {
        return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: alpha };
      }
    }
  }
  return undefined;
}

function parseChannel(value: string): number | undefined {
  const percent = value.endsWith('%');
  const number = Number(percent ? value.slice(0, -1) : value);
  if (!Number.isFinite(number)) return undefined;
  return clamp255(percent ? number * 2.55 : number);
}

function parseAlpha(value: string): number | undefined {
  const percent = value.endsWith('%');
  const number = Number(percent ? value.slice(0, -1) : value);
  if (!Number.isFinite(number)) return undefined;
  return clamp01(percent ? number / 100 : number);
}

function toCssColor(color: RgbaColor): string {
  const r = clamp255(color.r);
  const g = clamp255(color.g);
  const b = clamp255(color.b);
  const a = clamp01(color.a);
  return a >= 0.999999
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1_000_000) / 1_000_000})`;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
