import { actionableDiagnostics, diag, type Diagnostic, type RenderStats } from '../format/types.js';
import type { W2dPrimitive, W2dTextPageData } from '../format/document.js';
import { applyPathToCanvas, flattenPath } from './xpsPath.js';
import { multiplyMatrix, parseBrushColor, transformPoint, type Matrix2D } from './style.js';
import { adaptiveStrokeUserWidth, canvasDpr, estimateMatrixScale, shouldDrawTextByPixelSize, type CadLineStyleOptions } from './cadLineStyle.js';
import { matrixForW2d } from './viewport.js';
import { WasmRasterBackend } from '../wasm/WasmRasterBackend.js';
import { WebGlW2dBackend } from './WebGlW2dBackend.js';
import { drawGouraudTriangle, gouraudRasterBounds, MAX_CANVAS_GOURAUD_PIXELS } from './gouraud.js';

export interface W2dRenderOptions extends CadLineStyleOptions {
  zoom?: number;
  panX?: number;
  panY?: number;
  preferWebgl?: boolean;
  preferWasm?: boolean;
  wasmUrl?: string;
  background?: string;
  maxGpuCacheBytes?: number;
  maxCachedScenes?: number;
  webglCanvas?: HTMLCanvasElement;
  /**
   * Fill each Gouraud triangle with the average of its vertex colours instead of rasterising it. For contexts without
   * a document to create a raster canvas in, such as a vector (PDF/SVG) export; the raster pixel budget does not apply.
   */
  flatGouraud?: boolean;
}

export class W2dRenderer {
  private wasm?: WasmRasterBackend;
  private webgl?: WebGlW2dBackend;
  private webglCanvas?: HTMLCanvasElement;

  async render(page: W2dTextPageData, canvas: HTMLCanvasElement, options: W2dRenderOptions = {}): Promise<RenderStats> {
    const warnings: Diagnostic[] = actionableDiagnostics(page.diagnostics);
    const bg = options.background ?? '#ffffff';

    if (options.preferWebgl ?? true) {
      try {
        const backend = this.getWebGlBackend(options.webglCanvas);
        if (options.webglCanvas) options.webglCanvas.style.visibility = 'visible';
        const stats = backend.render(page, canvas, { ...options, compositeToTarget: !options.webglCanvas });
        const mem = formatBytes(stats.gpuBytes);
        const cacheText = stats.cacheHit ? 'cache hit' : 'cache upload';
        warnings.push(diag('info', 'WEBGL_W2D_RENDERED', `WebGL rendered ${stats.vertexCount} vertices, ${stats.textCount} text item(s), GPU cache ${mem}, ${cacheText}.`, page.sourcePath));
        warnings.push(...stats.warnings);
        return { backend: 'webgl', commands: stats.commands, warnings };
      } catch (err) {
        warnings.push(diag('warning', 'WEBGL_BACKEND_FALLBACK', `WebGL vector path failed, falling back to ${options.preferWasm ? 'WASM raster' : 'Canvas2D'}: ${String(err)}`, page.sourcePath));
      }
    }

    if (options.webglCanvas) options.webglCanvas.style.visibility = 'hidden';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CanvasRenderingContext2D is not available.');
    const pageMatrix = matrixForW2d(page, canvas.width, canvas.height, options.zoom, options.panX, options.panY);
    const runtime = { dpr: canvasDpr(canvas), zoom: options.zoom ?? 1 };
    let commands = 0;

    // The flat-fill WASM backend cannot interpolate per-vertex colors. Keep
    // the original paint order and use Canvas for the whole page in that case.
    const hasGouraud = page.primitives.some(p => p.type === 'polygon' && p.vertexColors);
    if (options.preferWasm && !hasGouraud) {
      try {
        this.wasm ??= new WasmRasterBackend({ wasmUrl: options.wasmUrl });
        await this.wasm.init();
        this.wasm.begin(canvas.width, canvas.height, bg);
        for (const p of page.primitives) commands += this.drawPrimitiveWasm(p, pageMatrix, options, runtime);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.putImageData(this.wasm.toImageData(), 0, 0);
        for (const p of page.primitives.filter(p => p.type === 'text')) commands += this.drawPrimitiveCanvas(ctx, p, pageMatrix, options, runtime);
        return { backend: 'wasm-raster', commands, warnings };
      } catch (err) {
        warnings.push(diag('warning', 'WASM_BACKEND_FALLBACK', `WASM raster path failed, falling back to Canvas2D: ${String(err)}`, page.sourcePath));
      }
    }

    // Reject an excessive fallback before painting any part of the page.
    let gouraudPixels = 0;
    for (const p of options.flatGouraud ? [] : page.primitives) {
      if (p.type !== 'polygon' || p.vertexColors?.length !== p.points.length / 2) continue;
      const matrix = multiplyMatrix(pageMatrix, p.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      for (let i = 1; i + 1 < p.vertexColors.length; i++) {
        const points = [0, i, i + 1].flatMap(index => transformPoint(matrix, p.points[index * 2]!, p.points[index * 2 + 1]!));
        const bounds = gouraudRasterBounds(points, canvas.width, canvas.height);
        gouraudPixels += bounds ? bounds.width * bounds.height : 0;
        if (gouraudPixels > MAX_CANVAS_GOURAUD_PIXELS) throw new Error('Canvas Gouraud frame pixel budget exceeded. Use WebGL or reduce the viewport.');
      }
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    for (const p of page.primitives) commands += this.drawPrimitiveCanvas(ctx, p, pageMatrix, options, runtime);
    return { backend: 'canvas2d', commands, warnings };
  }

  dispose(): void {
    this.webgl?.dispose();
    this.webgl = undefined;
    this.webglCanvas = undefined;
  }

  private getWebGlBackend(canvas?: HTMLCanvasElement): WebGlW2dBackend {
    if (!this.webgl || this.webglCanvas !== canvas) {
      this.webgl?.dispose();
      this.webgl = new WebGlW2dBackend(canvas);
      this.webglCanvas = canvas;
    }
    return this.webgl;
  }

  private drawPrimitiveCanvas(ctx: CanvasRenderingContext2D, p: W2dPrimitive, pageMatrix: Matrix2D, options: W2dRenderOptions, runtime: { dpr: number; zoom: number }): number {
    const matrix = multiplyMatrix(pageMatrix, p.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const stroke = parseBrushColor(p.stroke ?? '#000000') ?? '#000000';
    const fill = parseBrushColor(p.fill);
    let gouraudFilled = false;
    if (p.type === 'polygon' && p.vertexColors?.length === p.points.length / 2) {
      for (let i = 1; i + 1 < p.vertexColors.length; i++) {
        const indices = [0, i, i + 1];
        const points = indices.flatMap(index => transformPoint(matrix, p.points[index * 2]!, p.points[index * 2 + 1]!));
        const colors = indices.map(index => p.vertexColors![index]!);
        if (options.flatGouraud) drawFlatTriangle(ctx, points, colors);
        else drawGouraudTriangle(ctx, points, colors);
      }
      gouraudFilled = true;
      if (!p.stroke) return 1;
    }
    if (p.type === 'text') {
      const [x, y] = transformPoint(matrix, p.x, p.y);
      const screenSize = Math.max(1, Math.abs((p.size ?? 12) * estimateScale(matrix)));
      if (!shouldDrawTextByPixelSize(p.size ?? 12, matrix, options, runtime) || x > ctx.canvas.width + 64 || y > ctx.canvas.height + 64 || x < -ctx.canvas.width || y < -ctx.canvas.height) return 0;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = fill ?? stroke;
      ctx.font = `${Math.min(768, screenSize)}px sans-serif`;
      ctx.textBaseline = 'alphabetic';
      for (const [i, line] of p.text.split(/\n/).entries()) ctx.fillText(line, x, y + i * screenSize * 1.15);
      ctx.restore();
      return 1;
    }
    ctx.save();
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.lineWidth = adaptiveStrokeUserWidth(p.lineWidth ?? 1, matrix, options, runtime);
    if (p.type === 'polyline') {
      if (p.points.length >= 4) {
        ctx.beginPath();
        ctx.moveTo(p.points[0]!, p.points[1]!);
        for (let i = 2; i + 1 < p.points.length; i += 2) ctx.lineTo(p.points[i]!, p.points[i + 1]!);
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    } else if (p.type === 'polygon') {
      if (p.points.length >= 6) {
        ctx.beginPath();
        ctx.moveTo(p.points[0]!, p.points[1]!);
        for (let i = 2; i + 1 < p.points.length; i += 2) ctx.lineTo(p.points[i]!, p.points[i + 1]!);
        ctx.closePath();
        if (fill && !gouraudFilled) { ctx.fillStyle = fill; ctx.fill(); }
        if (p.stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
      }
    } else if (p.type === 'rect') {
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(p.x, p.y, p.width, p.height); }
      if (p.stroke) { ctx.strokeStyle = stroke; ctx.strokeRect(p.x, p.y, p.width, p.height); }
    } else if (p.type === 'path') {
      ctx.beginPath();
      applyPathToCanvas(ctx, p.commands);
      if (fill) { ctx.fillStyle = fill; ctx.fill(p.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'); }
      if (p.stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
    }
    ctx.restore();
    return 1;
  }

  private drawPrimitiveWasm(p: W2dPrimitive, pageMatrix: Matrix2D, options: W2dRenderOptions, runtime: { dpr: number; zoom: number }): number {
    if (!this.wasm || p.type === 'text') return 0;
    const matrix = multiplyMatrix(pageMatrix, p.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const scale = estimateMatrixScale(matrix);
    const screenStroke = (w: number | undefined) => adaptiveStrokeUserWidth(w ?? 1, matrix, options, runtime) * scale;
    if (p.type === 'polyline') {
      this.wasm.drawPolyline(p.points, matrix, parseBrushColor(p.stroke ?? '#000000'), screenStroke(p.lineWidth));
    } else if (p.type === 'polygon') {
      this.wasm.drawPolygon(p.points, matrix, parseBrushColor(p.fill));
      if (p.stroke) this.wasm.drawPolyline(closePoints(p.points), matrix, parseBrushColor(p.stroke), screenStroke(p.lineWidth));
    } else if (p.type === 'rect') {
      const pts = [p.x, p.y, p.x + p.width, p.y, p.x + p.width, p.y + p.height, p.x, p.y + p.height, p.x, p.y];
      if (p.fill) this.wasm.drawPolygon(pts, matrix, parseBrushColor(p.fill));
      if (p.stroke) this.wasm.drawPolyline(pts, matrix, parseBrushColor(p.stroke), screenStroke(p.lineWidth));
    } else if (p.type === 'path') {
      const subs = flattenPath(p.commands, 0.5);
      const fill = parseBrushColor(p.fill);
      const stroke = parseBrushColor(p.stroke);
      if (fill) for (const s of subs) if (s.closed || s.points.length >= 6) this.wasm.drawPolygon(s.points, matrix, fill);
      if (stroke) for (const s of subs) this.wasm.drawPolyline(s.points, matrix, stroke, screenStroke(p.lineWidth));
    }
    return 1;
  }
}

function closePoints(points: number[]): number[] {
  if (points.length < 4) return points;
  const x0 = points[0]!, y0 = points[1]!;
  const xn = points[points.length - 2]!, yn = points[points.length - 1]!;
  return x0 === xn && y0 === yn ? points : [...points, x0, y0];
}

function estimateScale(m: Matrix2D): number {
  return Math.max(1e-9, (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) * 0.5);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** One Gouraud triangle as a flat fill in the average of its vertex colours (option flatGouraud). */
function drawFlatTriangle(ctx: CanvasRenderingContext2D, points: number[], colors: string[]): void {
  const sum = [0, 0, 0, 0];
  for (const c of colors) {
    const m = /rgba?\(([^)]*)\)/i.exec(String(c));
    const v = m ? m[1]!.split(',').map(Number) : [0, 0, 0, 1];
    for (let i = 0; i < 4; i++) sum[i]! += i < 3 ? v[i] || 0 : (v[3] ?? 1);
  }
  const n = colors.length || 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.moveTo(points[0]!, points[1]!);
  ctx.lineTo(points[2]!, points[3]!);
  ctx.lineTo(points[4]!, points[5]!);
  ctx.closePath();
  ctx.fillStyle = `rgba(${Math.round(sum[0]! / n)}, ${Math.round(sum[1]! / n)}, ${Math.round(sum[2]! / n)}, ${sum[3]! / n})`;
  ctx.fill();
  ctx.restore();
}
