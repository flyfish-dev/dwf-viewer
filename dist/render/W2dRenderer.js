import { actionableDiagnostics, diag } from '../format/types.js';
import { applyPathToCanvas, flattenPath } from './xpsPath.js';
import { multiplyMatrix, parseBrushColor, transformPoint } from './style.js';
import { matrixForW2d } from './viewport.js';
import { WasmRasterBackend } from '../wasm/WasmRasterBackend.js';
import { WebGlW2dBackend } from './WebGlW2dBackend.js';
export class W2dRenderer {
    async render(page, canvas, options = {}) {
        const warnings = actionableDiagnostics(page.diagnostics);
        const bg = options.background ?? '#ffffff';
        if (options.preferWebgl ?? true) {
            try {
                const backend = this.getWebGlBackend(options.webglCanvas);
                if (options.webglCanvas)
                    options.webglCanvas.style.visibility = 'visible';
                const stats = backend.render(page, canvas, { ...options, compositeToTarget: !options.webglCanvas });
                const mem = formatBytes(stats.gpuBytes);
                const cacheText = stats.cacheHit ? 'cache hit' : 'cache upload';
                warnings.push(diag('info', 'WEBGL_W2D_RENDERED', `WebGL rendered ${stats.vertexCount} vertices, ${stats.textCount} text item(s), GPU cache ${mem}, ${cacheText}.`, page.sourcePath));
                warnings.push(...stats.warnings);
                return { backend: 'webgl', commands: stats.commands, warnings };
            }
            catch (err) {
                warnings.push(diag('warning', 'WEBGL_BACKEND_FALLBACK', `WebGL vector path failed, falling back to ${options.preferWasm ? 'WASM raster' : 'Canvas2D'}: ${String(err)}`, page.sourcePath));
            }
        }
        if (options.webglCanvas)
            options.webglCanvas.style.visibility = 'hidden';
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('CanvasRenderingContext2D is not available.');
        const pageMatrix = matrixForW2d(page, canvas.width, canvas.height, options.zoom, options.panX, options.panY);
        let commands = 0;
        if (options.preferWasm) {
            try {
                this.wasm ?? (this.wasm = new WasmRasterBackend({ wasmUrl: options.wasmUrl }));
                await this.wasm.init();
                this.wasm.begin(canvas.width, canvas.height, bg);
                for (const p of page.primitives)
                    commands += this.drawPrimitiveWasm(p, pageMatrix);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.putImageData(this.wasm.toImageData(), 0, 0);
                for (const p of page.primitives.filter(p => p.type === 'text'))
                    commands += this.drawPrimitiveCanvas(ctx, p, pageMatrix);
                return { backend: 'wasm-raster', commands, warnings };
            }
            catch (err) {
                warnings.push(diag('warning', 'WASM_BACKEND_FALLBACK', `WASM raster path failed, falling back to Canvas2D: ${String(err)}`, page.sourcePath));
            }
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        for (const p of page.primitives)
            commands += this.drawPrimitiveCanvas(ctx, p, pageMatrix);
        return { backend: 'canvas2d', commands, warnings };
    }
    dispose() {
        this.webgl?.dispose();
        this.webgl = undefined;
        this.webglCanvas = undefined;
    }
    getWebGlBackend(canvas) {
        if (!this.webgl || this.webglCanvas !== canvas) {
            this.webgl?.dispose();
            this.webgl = new WebGlW2dBackend(canvas);
            this.webglCanvas = canvas;
        }
        return this.webgl;
    }
    drawPrimitiveCanvas(ctx, p, pageMatrix) {
        const matrix = multiplyMatrix(pageMatrix, p.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        const stroke = parseBrushColor(p.stroke ?? '#000000') ?? '#000000';
        const fill = parseBrushColor(p.fill);
        if (p.type === 'text') {
            const [x, y] = transformPoint(matrix, p.x, p.y);
            const screenSize = Math.max(4, Math.abs((p.size ?? 12) * estimateScale(matrix)));
            if (screenSize < 2.5 || x > ctx.canvas.width + 64 || y > ctx.canvas.height + 64 || x < -ctx.canvas.width || y < -ctx.canvas.height)
                return 0;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = fill ?? stroke;
            ctx.font = `${Math.min(768, screenSize)}px sans-serif`;
            ctx.textBaseline = 'alphabetic';
            for (const [i, line] of p.text.split(/\n/).entries())
                ctx.fillText(line, x, y + i * screenSize * 1.15);
            ctx.restore();
            return 1;
        }
        ctx.save();
        ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        ctx.lineWidth = Math.max(0.1, (p.lineWidth ?? 1));
        if (p.type === 'polyline') {
            if (p.points.length >= 4) {
                ctx.beginPath();
                ctx.moveTo(p.points[0], p.points[1]);
                for (let i = 2; i + 1 < p.points.length; i += 2)
                    ctx.lineTo(p.points[i], p.points[i + 1]);
                ctx.strokeStyle = stroke;
                ctx.stroke();
            }
        }
        else if (p.type === 'polygon') {
            if (p.points.length >= 6) {
                ctx.beginPath();
                ctx.moveTo(p.points[0], p.points[1]);
                for (let i = 2; i + 1 < p.points.length; i += 2)
                    ctx.lineTo(p.points[i], p.points[i + 1]);
                ctx.closePath();
                if (fill) {
                    ctx.fillStyle = fill;
                    ctx.fill();
                }
                if (p.stroke) {
                    ctx.strokeStyle = stroke;
                    ctx.stroke();
                }
            }
        }
        else if (p.type === 'rect') {
            if (fill) {
                ctx.fillStyle = fill;
                ctx.fillRect(p.x, p.y, p.width, p.height);
            }
            if (p.stroke) {
                ctx.strokeStyle = stroke;
                ctx.strokeRect(p.x, p.y, p.width, p.height);
            }
        }
        else if (p.type === 'path') {
            ctx.beginPath();
            applyPathToCanvas(ctx, p.commands);
            if (fill) {
                ctx.fillStyle = fill;
                ctx.fill();
            }
            if (p.stroke) {
                ctx.strokeStyle = stroke;
                ctx.stroke();
            }
        }
        ctx.restore();
        return 1;
    }
    drawPrimitiveWasm(p, pageMatrix) {
        if (!this.wasm || p.type === 'text')
            return 0;
        const matrix = multiplyMatrix(pageMatrix, p.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        const scale = estimateScale(matrix);
        if (p.type === 'polyline') {
            this.wasm.drawPolyline(p.points, matrix, parseBrushColor(p.stroke ?? '#000000'), (p.lineWidth ?? 1) * scale);
        }
        else if (p.type === 'polygon') {
            this.wasm.drawPolygon(p.points, matrix, parseBrushColor(p.fill));
            if (p.stroke)
                this.wasm.drawPolyline(closePoints(p.points), matrix, parseBrushColor(p.stroke), (p.lineWidth ?? 1) * scale);
        }
        else if (p.type === 'rect') {
            const pts = [p.x, p.y, p.x + p.width, p.y, p.x + p.width, p.y + p.height, p.x, p.y + p.height, p.x, p.y];
            if (p.fill)
                this.wasm.drawPolygon(pts, matrix, parseBrushColor(p.fill));
            if (p.stroke)
                this.wasm.drawPolyline(pts, matrix, parseBrushColor(p.stroke), (p.lineWidth ?? 1) * scale);
        }
        else if (p.type === 'path') {
            const subs = flattenPath(p.commands, 0.5);
            const fill = parseBrushColor(p.fill);
            const stroke = parseBrushColor(p.stroke);
            if (fill)
                for (const s of subs)
                    if (s.closed || s.points.length >= 6)
                        this.wasm.drawPolygon(s.points, matrix, fill);
            if (stroke)
                for (const s of subs)
                    this.wasm.drawPolyline(s.points, matrix, stroke, (p.lineWidth ?? 1) * scale);
        }
        return 1;
    }
}
function closePoints(points) {
    if (points.length < 4)
        return points;
    const x0 = points[0], y0 = points[1];
    const xn = points[points.length - 2], yn = points[points.length - 1];
    return x0 === xn && y0 === yn ? points : [...points, x0, y0];
}
function estimateScale(m) {
    return Math.max(1e-9, (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) * 0.5);
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
