import { diag } from '../format/types.js';
import { flattenPath } from './xpsPath.js';
import { colorToRgba32, multiplyMatrix, transformPoint } from './style.js';
import { matrixForW2d } from './viewport.js';
const VERTEX_STRIDE = 12;
const DEFAULT_MAX_GPU_CACHE_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_CACHED_SCENES = 3;
export class WebGlW2dBackend {
    constructor(canvas) {
        this.scenes = new Map();
        this.gpuBytes = 0;
        this.tick = 0;
        this.canvas = canvas ?? document.createElement('canvas');
        const gl = this.canvas.getContext('webgl', {
            alpha: false,
            antialias: true,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance'
        });
        if (!gl)
            throw new Error('WebGLRenderingContext is not available.');
        this.gl = gl;
        this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
        this.aPos = gl.getAttribLocation(this.program, 'a_pos');
        this.aColor = gl.getAttribLocation(this.program, 'a_color');
        const matrix = gl.getUniformLocation(this.program, 'u_matrix');
        const viewport = gl.getUniformLocation(this.program, 'u_viewport');
        if (this.aPos < 0 || this.aColor < 0 || !matrix || !viewport)
            throw new Error('Failed to resolve WebGL shader locations.');
        this.uMatrix = matrix;
        this.uViewport = viewport;
    }
    render(page, targetCanvas, options = {}) {
        const warnings = [];
        if (targetCanvas.width <= 0 || targetCanvas.height <= 0) {
            return { commands: 0, warnings, gpuBytes: this.gpuBytes, vertexCount: 0, textCount: 0, cacheHit: true };
        }
        this.resize(targetCanvas.width, targetCanvas.height);
        const key = sceneKey(page);
        let scene = this.scenes.get(key);
        const cacheHit = !!scene;
        if (!scene) {
            scene = this.compileScene(page, key, options);
            this.scenes.set(key, scene);
            this.gpuBytes += scene.gpuBytes;
            this.evictIfNeeded(options);
            // Scene can be evicted only if it is not the newly needed scene; get again for safety.
            scene = this.scenes.get(key) ?? scene;
        }
        scene.lastUsed = ++this.tick;
        const gl = this.gl;
        const bg = rgba01(options.background ?? '#ffffff');
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const pageMatrix = matrixForW2d(page, this.canvas.width, this.canvas.height, options.zoom, options.panX, options.panY);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, scene.buffer);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, VERTEX_STRIDE, 0);
        gl.enableVertexAttribArray(this.aColor);
        gl.vertexAttribPointer(this.aColor, 4, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, 8);
        gl.uniform4f(this.uMatrix, pageMatrix.a, pageMatrix.b, pageMatrix.c, pageMatrix.d);
        gl.uniform4f(this.uViewport, pageMatrix.e, pageMatrix.f, this.canvas.width, this.canvas.height);
        gl.drawArrays(gl.TRIANGLES, 0, scene.vertexCount);
        const ctx = targetCanvas.getContext('2d');
        if (!ctx)
            throw new Error('CanvasRenderingContext2D is not available for WebGL text overlay.');
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        if (options.compositeToTarget ?? true)
            ctx.drawImage(this.canvas, 0, 0);
        this.drawTextOverlay(ctx, page, pageMatrix);
        ctx.restore();
        if (scene.vertexCount === 0 && page.primitives.some(p => p.type !== 'text')) {
            warnings.push(diag('warning', 'WEBGL_EMPTY_SCENE', 'WebGL scene contained no drawable geometry; Canvas/WASM fallback may be required.', page.sourcePath));
        }
        return {
            commands: scene.primitiveCount,
            warnings,
            gpuBytes: this.gpuBytes,
            vertexCount: scene.vertexCount,
            textCount: scene.textCount,
            cacheHit
        };
    }
    dispose() {
        for (const scene of this.scenes.values())
            this.gl.deleteBuffer(scene.buffer);
        this.scenes.clear();
        this.gpuBytes = 0;
    }
    resize(width, height) {
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }
    compileScene(page, key, options) {
        const writer = new VertexWriter();
        let primitiveCount = 0;
        let textCount = 0;
        for (const p of page.primitives) {
            if (p.type === 'text') {
                textCount++;
                continue;
            }
            primitiveCount++;
            appendPrimitive(writer, p);
        }
        const bufferBytes = writer.byteLength;
        const maxBytes = options.maxGpuCacheBytes ?? DEFAULT_MAX_GPU_CACHE_BYTES;
        if (bufferBytes > maxBytes) {
            throw new Error(`WebGL scene buffer would require ${formatBytes(bufferBytes)}, exceeding maxGpuCacheBytes=${formatBytes(maxBytes)}.`);
        }
        const gl = this.gl;
        const buffer = gl.createBuffer();
        if (!buffer)
            throw new Error('Failed to allocate WebGLBuffer.');
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, writer.toArrayBuffer(), gl.STATIC_DRAW);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
            gl.deleteBuffer(buffer);
            throw new Error(`WebGL buffer upload failed: 0x${err.toString(16)}.`);
        }
        return {
            key,
            buffer,
            vertexCount: writer.vertexCount,
            gpuBytes: bufferBytes,
            primitiveCount,
            textCount,
            lastUsed: ++this.tick
        };
    }
    evictIfNeeded(options) {
        const maxBytes = options.maxGpuCacheBytes ?? DEFAULT_MAX_GPU_CACHE_BYTES;
        const maxScenes = options.maxCachedScenes ?? DEFAULT_MAX_CACHED_SCENES;
        while (this.scenes.size > Math.max(1, maxScenes) || this.gpuBytes > maxBytes) {
            let oldest;
            for (const scene of this.scenes.values()) {
                if (!oldest || scene.lastUsed < oldest.lastUsed)
                    oldest = scene;
            }
            if (!oldest)
                break;
            this.scenes.delete(oldest.key);
            this.gl.deleteBuffer(oldest.buffer);
            this.gpuBytes -= oldest.gpuBytes;
        }
    }
    drawTextOverlay(ctx, page, pageMatrix) {
        const canvasW = this.canvas.width;
        const canvasH = this.canvas.height;
        for (const p of page.primitives) {
            if (p.type !== 'text')
                continue;
            const matrix = multiplyMatrix(pageMatrix, p.matrix ?? IDENTITY_MATRIX);
            const [x, y] = transformPoint(matrix, p.x, p.y);
            const scale = estimateScale(matrix);
            const screenSize = Math.max(2, Math.min(768, Math.abs((p.size ?? 12) * scale)));
            if (screenSize < 2.5)
                continue;
            const lines = p.text.split(/\n/);
            const longest = lines.reduce((m, line) => Math.max(m, line.length), 0);
            const roughWidth = Math.max(24, longest * screenSize * 0.65);
            const roughHeight = Math.max(screenSize, lines.length * screenSize * 1.15);
            if (x + roughWidth < -64 || x > canvasW + 64 || y + roughHeight < -64 || y - roughHeight > canvasH + 64)
                continue;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = p.fill ?? p.stroke ?? '#000000';
            ctx.font = `${screenSize}px sans-serif`;
            ctx.textBaseline = 'alphabetic';
            for (let i = 0; i < lines.length; i++)
                ctx.fillText(lines[i] ?? '', x, y + i * screenSize * 1.15);
            ctx.restore();
        }
    }
}
const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
function sceneKey(page) {
    return `${page.id}|${page.sourcePath}|${page.primitives.length}`;
}
class VertexWriter {
    constructor() {
        this.buffer = new ArrayBuffer(64 * 1024);
        this.view = new DataView(this.buffer);
        this.vertexCount = 0;
    }
    get byteLength() { return this.vertexCount * VERTEX_STRIDE; }
    push(x, y, color) {
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        const offset = this.byteLength;
        this.ensure(VERTEX_STRIDE);
        this.view.setFloat32(offset, x, true);
        this.view.setFloat32(offset + 4, y, true);
        this.view.setUint8(offset + 8, color.r);
        this.view.setUint8(offset + 9, color.g);
        this.view.setUint8(offset + 10, color.b);
        this.view.setUint8(offset + 11, color.a);
        this.vertexCount++;
    }
    toArrayBuffer() {
        return this.buffer.slice(0, this.byteLength);
    }
    ensure(extraBytes) {
        const needed = this.byteLength + extraBytes;
        if (needed <= this.buffer.byteLength)
            return;
        let next = this.buffer.byteLength;
        while (next < needed)
            next *= 2;
        const newBuffer = new ArrayBuffer(next);
        new Uint8Array(newBuffer).set(new Uint8Array(this.buffer, 0, this.byteLength));
        this.buffer = newBuffer;
        this.view = new DataView(this.buffer);
    }
}
function appendPrimitive(writer, p) {
    const m = p.matrix ?? IDENTITY_MATRIX;
    const matrixScale = estimateScale(m);
    const lineWidth = Math.max(0.1, (p.lineWidth ?? 1) * matrixScale);
    if (p.type === 'polyline') {
        const color = rgbaBytes(p.stroke ?? '#000000');
        appendPolyline(writer, transformPointsArray(p.points, m), lineWidth, color);
    }
    else if (p.type === 'polygon') {
        const pts = transformPointsArray(p.points, m);
        if (p.fill)
            appendPolygonFan(writer, pts, rgbaBytes(p.fill));
        if (p.stroke)
            appendPolyline(writer, closePoints(pts), lineWidth, rgbaBytes(p.stroke));
    }
    else if (p.type === 'rect') {
        const pts = transformPointsArray([
            p.x, p.y,
            p.x + p.width, p.y,
            p.x + p.width, p.y + p.height,
            p.x, p.y + p.height
        ], m);
        if (p.fill)
            appendPolygonFan(writer, pts, rgbaBytes(p.fill));
        if (p.stroke)
            appendPolyline(writer, closePoints(pts), lineWidth, rgbaBytes(p.stroke));
    }
    else if (p.type === 'path') {
        const subs = flattenPath(p.commands, 0.5);
        const fill = p.fill ? rgbaBytes(p.fill) : undefined;
        const stroke = p.stroke ? rgbaBytes(p.stroke) : undefined;
        for (const sub of subs) {
            const pts = transformPointsArray(sub.points, m);
            if (fill && (sub.closed || pts.length >= 6))
                appendPolygonFan(writer, pts, fill);
            if (stroke)
                appendPolyline(writer, pts, lineWidth, stroke);
        }
    }
}
function transformPointsArray(points, m) {
    const out = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
        const [x, y] = transformPoint(m, points[i] ?? 0, points[i + 1] ?? 0);
        out.push({ x, y });
    }
    return out;
}
function appendPolygonFan(writer, pts, color) {
    if (pts.length < 3)
        return;
    const p0 = pts[0];
    for (let i = 1; i + 1 < pts.length; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        if (triangleAreaAbs(p0, p1, p2) < 1e-6)
            continue;
        writer.push(p0.x, p0.y, color);
        writer.push(p1.x, p1.y, color);
        writer.push(p2.x, p2.y, color);
    }
}
function appendPolyline(writer, pts, width, color) {
    if (pts.length < 2)
        return;
    const half = Math.max(0.05, width * 0.5);
    for (let i = 0; i + 1 < pts.length; i++)
        appendLineSegment(writer, pts[i], pts[i + 1], half, color);
}
function appendLineSegment(writer, p0, p1, half, color) {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-9)
        return;
    const nx = -dy / len * half;
    const ny = dx / len * half;
    const ax = p0.x + nx, ay = p0.y + ny;
    const bx = p0.x - nx, by = p0.y - ny;
    const cx = p1.x - nx, cy = p1.y - ny;
    const dx2 = p1.x + nx, dy2 = p1.y + ny;
    writer.push(ax, ay, color);
    writer.push(bx, by, color);
    writer.push(cx, cy, color);
    writer.push(ax, ay, color);
    writer.push(cx, cy, color);
    writer.push(dx2, dy2, color);
}
function closePoints(pts) {
    if (pts.length < 2)
        return pts;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first.x === last.x && first.y === last.y)
        return pts;
    return [...pts, { x: first.x, y: first.y }];
}
function triangleAreaAbs(a, b, c) {
    return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}
function estimateScale(m) {
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    return Math.max(1e-9, (sx + sy) * 0.5);
}
function rgbaBytes(css) {
    const packed = colorToRgba32(css, 0xff000000);
    return { r: packed & 255, g: (packed >>> 8) & 255, b: (packed >>> 16) & 255, a: (packed >>> 24) & 255 };
}
function rgba01(css) {
    const c = rgbaBytes(css);
    return [c.r / 255, c.g / 255, c.b / 255, c.a / 255];
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function createProgram(gl, vertexSource, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program)
        throw new Error('Failed to create WebGLProgram.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
        gl.deleteProgram(program);
        throw new Error(`WebGL program link failed: ${log}`);
    }
    return program;
}
function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader)
        throw new Error('Failed to create WebGLShader.');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? 'unknown shader compile error';
        gl.deleteShader(shader);
        throw new Error(`WebGL shader compile failed: ${log}`);
    }
    return shader;
}
const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec4 a_color;
uniform vec4 u_matrix;
uniform vec4 u_viewport;
varying vec4 v_color;
void main() {
  float x = u_matrix.x * a_pos.x + u_matrix.z * a_pos.y + u_viewport.x;
  float y = u_matrix.y * a_pos.x + u_matrix.w * a_pos.y + u_viewport.y;
  vec2 clip = vec2((x / u_viewport.z) * 2.0 - 1.0, 1.0 - (y / u_viewport.w) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}
`;
const FRAGMENT_SHADER = `
precision mediump float;
varying vec4 v_color;
void main() {
  gl_FragColor = v_color;
}
`;
