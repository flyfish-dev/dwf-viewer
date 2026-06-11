import { actionableDiagnostics, diag } from '../format/types.js';
import { childElements, getAttr, localName, parseNumberList, parseXml, resolvePart, blobToImage, mimeFromPath } from '../format/util.js';
import { applyPathToCanvas, flattenPath, parsePathData } from './xpsPath.js';
import { multiplyMatrix, parseBrushColor, parseMatrix } from './style.js';
import { fitPageMatrix } from './viewport.js';
import { WasmRasterBackend } from '../wasm/WasmRasterBackend.js';
export class XpsRenderer {
    constructor(document) {
        this.document = document;
    }
    async render(page, canvas, options = {}) {
        const opc = this.document.opc;
        if (!opc)
            throw new Error('XPS page requires an OPC package view.');
        const warnings = actionableDiagnostics(page.diagnostics);
        const xml = await opc.readText(page.sourcePath);
        const doc = parseXml(xml, page.sourcePath);
        const root = doc.documentElement;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('CanvasRenderingContext2D is not available.');
        const bg = options.background ?? '#ffffff';
        const pageMatrix = fitPageMatrix({ canvasWidth: canvas.width, canvasHeight: canvas.height, pageWidth: page.width, pageHeight: page.height, zoom: options.zoom, panX: options.panX, panY: options.panY });
        let commands = 0;
        if (options.preferWasm) {
            try {
                this.wasm ?? (this.wasm = new WasmRasterBackend({ wasmUrl: options.wasmUrl }));
                await this.wasm.init();
                this.wasm.begin(canvas.width, canvas.height, bg);
                commands += this.renderElementToWasm(root, pageMatrix, 1, warnings);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.putImageData(this.wasm.toImageData(), 0, 0);
                commands += await this.renderElementToCanvas(root, ctx, page.sourcePath, pageMatrix, 1, warnings, { vectors: false, overlays: true });
                return { backend: 'wasm-raster', commands, warnings };
            }
            catch (err) {
                warnings.push(diag('warning', 'WASM_BACKEND_FALLBACK', `WASM raster path failed, falling back to Canvas2D: ${String(err)}`));
            }
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        commands += await this.renderElementToCanvas(root, ctx, page.sourcePath, pageMatrix, 1, warnings, { vectors: true, overlays: true });
        return { backend: 'canvas2d', commands, warnings };
    }
    async renderElementToCanvas(el, ctx, pagePath, matrix, opacity, warnings, mode) {
        const name = localName(el);
        const local = elementMatrix(el);
        const composed = multiplyMatrix(matrix, local);
        const ownOpacity = opacity * parseOpacity(getAttr(el, 'Opacity'));
        let commands = 0;
        if (name === 'Path' && mode.vectors) {
            const path = extractPathCommands(el);
            if (path.length > 0) {
                ctx.save();
                ctx.setTransform(composed.a, composed.b, composed.c, composed.d, composed.e, composed.f);
                ctx.globalAlpha = ownOpacity;
                const clip = getAttr(el, 'Clip');
                if (clip) {
                    ctx.beginPath();
                    applyPathToCanvas(ctx, parsePathData(clip));
                    ctx.clip();
                }
                ctx.beginPath();
                applyPathToCanvas(ctx, path);
                const fill = extractBrush(el, 'Fill', ownOpacity);
                const stroke = extractBrush(el, 'Stroke', ownOpacity);
                const thickness = Number(getAttr(el, 'StrokeThickness') ?? 1);
                if (fill) {
                    ctx.fillStyle = fill;
                    ctx.fill(fillRule(el));
                }
                if (stroke && thickness > 0) {
                    ctx.strokeStyle = stroke;
                    ctx.lineWidth = thickness;
                    ctx.stroke();
                }
                ctx.restore();
                commands++;
            }
        }
        else if (name === 'Glyphs' && mode.overlays) {
            ctx.save();
            ctx.setTransform(composed.a, composed.b, composed.c, composed.d, composed.e, composed.f);
            ctx.globalAlpha = ownOpacity;
            const text = getAttr(el, 'UnicodeString') ?? '';
            const x = Number(getAttr(el, 'OriginX') ?? 0);
            const y = Number(getAttr(el, 'OriginY') ?? 0);
            const size = Number(getAttr(el, 'FontRenderingEmSize') ?? 12);
            const fill = extractBrush(el, 'Fill', ownOpacity) ?? '#000000';
            ctx.fillStyle = fill;
            ctx.font = `${size}px sans-serif`;
            ctx.fillText(text, x, y);
            ctx.restore();
            commands++;
        }
        else if (name === 'Image' && mode.overlays) {
            const source = getAttr(el, 'Source') ?? getAttr(el, 'ImageSource');
            if (source) {
                try {
                    await this.drawImageResource(ctx, pagePath, source, composed, ownOpacity, el);
                    commands++;
                }
                catch (err) {
                    warnings.push(diag('warning', 'XPS_IMAGE_DRAW_FAILED', `Failed to draw image ${source}: ${String(err)}`, pagePath));
                }
            }
        }
        else if (name === 'Canvas' || name === 'FixedPage' || name.endsWith('.RenderTransform') || name.endsWith('.Resources')) {
            // Container or non-rendering property element.
        }
        // Path.Fill with ImageBrush: draw as overlay clipped to path.
        if (name === 'Path' && mode.overlays) {
            const imageBrush = findPropertyBrush(el, 'Fill', 'ImageBrush');
            const imageSource = imageBrush ? getAttr(imageBrush, 'ImageSource') : undefined;
            if (imageBrush && imageSource) {
                try {
                    await this.drawImageBrush(ctx, pagePath, imageSource, composed, ownOpacity, el, imageBrush);
                    commands++;
                }
                catch (err) {
                    warnings.push(diag('warning', 'XPS_IMAGEBRUSH_FAILED', `Failed to draw ImageBrush ${imageSource}: ${String(err)}`, pagePath));
                }
            }
        }
        for (const child of childElements(el)) {
            const childName = localName(child);
            if (childName.includes('.'))
                continue;
            commands += await this.renderElementToCanvas(child, ctx, pagePath, composed, ownOpacity, warnings, mode);
        }
        return commands;
    }
    renderElementToWasm(el, matrix, opacity, warnings) {
        if (!this.wasm)
            return 0;
        const name = localName(el);
        const local = elementMatrix(el);
        const composed = multiplyMatrix(matrix, local);
        const ownOpacity = opacity * parseOpacity(getAttr(el, 'Opacity'));
        let commands = 0;
        if (name === 'Path') {
            const path = extractPathCommands(el);
            if (path.length > 0) {
                const fill = extractBrush(el, 'Fill', ownOpacity);
                const stroke = extractBrush(el, 'Stroke', ownOpacity);
                const thickness = Number(getAttr(el, 'StrokeThickness') ?? 1);
                const subs = flattenPath(path, 0.5);
                if (fill) {
                    for (const sub of subs)
                        if (sub.closed || sub.points.length >= 6)
                            this.wasm.drawPolygon(sub.points, composed, fill);
                }
                if (stroke && thickness > 0) {
                    for (const sub of subs)
                        this.wasm.drawPolyline(sub.points, composed, stroke, thickness * composed.a);
                }
                commands++;
            }
        }
        for (const child of childElements(el)) {
            const childName = localName(child);
            if (childName.includes('.'))
                continue;
            commands += this.renderElementToWasm(child, composed, ownOpacity, warnings);
        }
        return commands;
    }
    async drawImageResource(ctx, pagePath, source, matrix, opacity, el) {
        const opc = this.document.opc;
        const src = resolvePart(pagePath, source.replace(/^\//, ''));
        const bytes = await opc.readBytes(src);
        const image = await blobToImage(bytes, opc.getContentType(src) ?? mimeFromPath(src) ?? 'image/png');
        const width = Number(getAttr(el, 'Width') ?? ('width' in image ? image.width : 0));
        const height = Number(getAttr(el, 'Height') ?? ('height' in image ? image.height : 0));
        const x = Number(getAttr(el, 'Canvas.Left') ?? getAttr(el, 'X') ?? 0);
        const y = Number(getAttr(el, 'Canvas.Top') ?? getAttr(el, 'Y') ?? 0);
        ctx.save();
        ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        ctx.globalAlpha = opacity;
        ctx.drawImage(image, x, y, width || image.width, height || image.height);
        ctx.restore();
    }
    async drawImageBrush(ctx, pagePath, source, matrix, opacity, pathEl, brushEl) {
        const opc = this.document.opc;
        const src = resolvePart(pagePath, source.replace(/^\//, ''));
        const bytes = await opc.readBytes(src);
        const image = await blobToImage(bytes, opc.getContentType(src) ?? mimeFromPath(src) ?? 'image/png');
        const viewport = parseRect(getAttr(brushEl, 'Viewport')) ?? parseRect(getAttr(brushEl, 'Viewbox')) ?? [0, 0, Number(image.width ?? 1), Number(image.height ?? 1)];
        const path = extractPathCommands(pathEl);
        ctx.save();
        ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        ctx.globalAlpha = opacity;
        if (path.length > 0) {
            ctx.beginPath();
            applyPathToCanvas(ctx, path);
            ctx.clip();
        }
        ctx.drawImage(image, viewport[0], viewport[1], viewport[2], viewport[3]);
        ctx.restore();
    }
}
function elementMatrix(el) {
    let m = parseMatrix(getAttr(el, 'RenderTransform') ?? getAttr(el, 'Transform'));
    for (const child of childElements(el)) {
        const name = localName(child);
        if (name.endsWith('.RenderTransform') || name.endsWith('.Transform')) {
            const matrixEl = childElements(child).find(c => localName(c) === 'MatrixTransform');
            if (matrixEl)
                m = multiplyMatrix(m, parseMatrix(getAttr(matrixEl, 'Matrix')));
        }
    }
    const left = Number(getAttr(el, 'Canvas.Left') ?? 0);
    const top = Number(getAttr(el, 'Canvas.Top') ?? 0);
    if (left || top)
        m = multiplyMatrix({ a: 1, b: 0, c: 0, d: 1, e: left, f: top }, m);
    return m;
}
function extractPathCommands(pathEl) {
    const data = getAttr(pathEl, 'Data');
    if (data)
        return parsePathData(data);
    for (const prop of childElements(pathEl)) {
        if (localName(prop) !== 'Path.Data')
            continue;
        for (const geom of childElements(prop)) {
            const figures = getAttr(geom, 'Figures');
            if (figures)
                return parsePathData(figures);
            if (localName(geom) === 'PathGeometry') {
                const built = buildPathGeometry(geom);
                if (built)
                    return parsePathData(built);
            }
        }
    }
    return [];
}
function buildPathGeometry(geom) {
    const parts = [];
    for (const figure of childElements(geom).filter(e => localName(e) === 'PathFigure')) {
        const start = parseNumberList(getAttr(figure, 'StartPoint') ?? '');
        if (start.length >= 2)
            parts.push(`M ${start[0]} ${start[1]}`);
        for (const seg of childElements(figure)) {
            const name = localName(seg);
            if (name === 'LineSegment') {
                const p = parseNumberList(getAttr(seg, 'Point') ?? '');
                if (p.length >= 2)
                    parts.push(`L ${p[0]} ${p[1]}`);
            }
            else if (name === 'PolyLineSegment') {
                const nums = parseNumberList(getAttr(seg, 'Points') ?? '');
                for (let i = 0; i + 1 < nums.length; i += 2)
                    parts.push(`L ${nums[i]} ${nums[i + 1]}`);
            }
            else if (name === 'BezierSegment') {
                const nums = parseNumberList(getAttr(seg, 'Point1') + ' ' + getAttr(seg, 'Point2') + ' ' + getAttr(seg, 'Point3'));
                if (nums.length >= 6)
                    parts.push(`C ${nums.slice(0, 6).join(' ')}`);
            }
            else if (name === 'PolyBezierSegment') {
                const nums = parseNumberList(getAttr(seg, 'Points') ?? '');
                for (let i = 0; i + 5 < nums.length; i += 6)
                    parts.push(`C ${nums.slice(i, i + 6).join(' ')}`);
            }
        }
        if (getAttr(figure, 'IsClosed') === 'true')
            parts.push('Z');
    }
    return parts.length ? parts.join(' ') : undefined;
}
function extractBrush(el, prop, opacity) {
    const direct = getAttr(el, prop);
    if (direct)
        return parseBrushColor(direct, opacity);
    const solid = findPropertyBrush(el, prop, 'SolidColorBrush');
    if (solid)
        return parseBrushColor(getAttr(solid, 'Color'), opacity * parseOpacity(getAttr(solid, 'Opacity')));
    return undefined;
}
function findPropertyBrush(el, prop, brushLocalName) {
    const propName = `${localName(el)}.${prop}`;
    for (const child of childElements(el)) {
        if (localName(child) !== propName)
            continue;
        return childElements(child).find(c => localName(c) === brushLocalName);
    }
    return undefined;
}
function parseOpacity(value) {
    if (!value)
        return 1;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}
function fillRule(el) {
    const data = getAttr(el, 'Data') ?? '';
    return /F0/.test(data) ? 'nonzero' : 'evenodd';
}
function parseRect(s) {
    if (!s)
        return undefined;
    const nums = parseNumberList(s);
    if (nums.length >= 4)
        return [nums[0], nums[1], nums[2], nums[3]];
    return undefined;
}
