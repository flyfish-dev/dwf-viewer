import { parseNumberList } from '../format/util.js';
export const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export function multiplyMatrix(m1, m2) {
    return {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f
    };
}
export function transformPoint(m, x, y) {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}
export function parseMatrix(input) {
    if (!input)
        return { ...IDENTITY };
    const nums = parseNumberList(input);
    if (nums.length >= 6)
        return { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
    return { ...IDENTITY };
}
export function applyMatrixToContext(ctx, m) {
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
}
export function parseBrushColor(input, opacity = 1) {
    if (!input || input === 'Transparent' || input === '{x:Null}')
        return undefined;
    let s = input.trim();
    if (s.startsWith('{') || s.includes('Brush'))
        return undefined;
    const known = namedColor(s);
    if (known)
        s = known;
    if (s.startsWith('sc#')) {
        const nums = parseNumberList(s);
        if (nums.length >= 3) {
            const offset = nums.length >= 4 ? 1 : 0;
            const a = nums.length >= 4 ? nums[0] : 1;
            const r = Math.round((nums[offset] ?? 0) * 255);
            const g = Math.round((nums[offset + 1] ?? 0) * 255);
            const b = Math.round((nums[offset + 2] ?? 0) * 255);
            return rgba(r, g, b, a * opacity);
        }
    }
    if (s.startsWith('#')) {
        const hex = s.slice(1);
        if (hex.length === 3) {
            const r = parseInt(hex[0] + hex[0], 16);
            const g = parseInt(hex[1] + hex[1], 16);
            const b = parseInt(hex[2] + hex[2], 16);
            return rgba(r, g, b, opacity);
        }
        if (hex.length === 6) {
            return rgba(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), opacity);
        }
        if (hex.length === 8) {
            // XPS uses #AARRGGBB; CSS often uses #RRGGBBAA. Prefer XPS semantics for FixedPage.
            const a = parseInt(hex.slice(0, 2), 16) / 255;
            return rgba(parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16), a * opacity);
        }
    }
    if (/^rgba?\(/i.test(s))
        return s;
    return s;
}
export function colorToRgba32(css, fallback = 0xff000000) {
    if (!css)
        return fallback;
    const s = css.trim();
    const rgbaMatch = s.match(/^rgba?\(([^)]+)\)/i);
    if (rgbaMatch) {
        const parts = rgbaMatch[1].split(',').map(x => x.trim());
        const r = Number(parts[0] ?? 0), g = Number(parts[1] ?? 0), b = Number(parts[2] ?? 0);
        const a = parts[3] === undefined ? 1 : Number(parts[3]);
        return packRgba(r, g, b, Math.round(a * 255));
    }
    if (s.startsWith('#')) {
        const hex = s.slice(1);
        if (hex.length === 6)
            return packRgba(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255);
        if (hex.length === 8)
            return packRgba(parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16), parseInt(hex.slice(0, 2), 16));
    }
    const known = namedColor(s);
    return known ? colorToRgba32(known, fallback) : fallback;
}
export function packRgba(r, g, b, a) {
    r = clamp255(r);
    g = clamp255(g);
    b = clamp255(b);
    a = clamp255(a);
    return (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24);
}
function rgba(r, g, b, a) {
    return `rgba(${clamp255(r)}, ${clamp255(g)}, ${clamp255(b)}, ${Math.max(0, Math.min(1, a))})`;
}
function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function namedColor(s) {
    switch (s.toLowerCase()) {
        case 'black': return '#000000';
        case 'white': return '#ffffff';
        case 'red': return '#ff0000';
        case 'green': return '#008000';
        case 'blue': return '#0000ff';
        case 'yellow': return '#ffff00';
        case 'cyan': return '#00ffff';
        case 'magenta': return '#ff00ff';
        case 'gray':
        case 'grey': return '#808080';
        case 'transparent': return '#00000000';
        default: return undefined;
    }
}
