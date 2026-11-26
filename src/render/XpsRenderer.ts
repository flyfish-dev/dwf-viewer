import { actionableDiagnostics, diag, type Diagnostic, type RenderStats } from '../format/types.js';
import type { LoadedDwfDocument, XpsPageData } from '../format/document.js';
import type { OpcPackageView } from '../format/opc.js';
import { childElements, getAttr, localName, parseNumberList, parseXml, resolvePart, blobToImage, mimeFromPath } from '../format/util.js';
import { applyPathToCanvas, flattenPath, parsePathData, type PathCommand } from './xpsPath.js';
import { IDENTITY, multiplyMatrix, parseBrushColor, parseMatrix, type Matrix2D } from './style.js';
import { adaptiveStrokeUserWidth, canvasDpr, shouldDrawFilledBounds, shouldDrawTextByPixelSize, type CadLineStyleOptions } from './cadLineStyle.js';
import { fitPageMatrix } from './viewport.js';
import { WasmRasterBackend } from '../wasm/WasmRasterBackend.js';
import { WebGlXpsBackend } from './WebGlXpsBackend.js';

export interface XpsRenderOptions extends CadLineStyleOptions {
  zoom?: number;
  panX?: number;
  panY?: number;
  preferWebgl?: boolean;
  preferWasm?: boolean;
  wasmUrl?: string;
  webglCanvas?: HTMLCanvasElement;
  maxGpuCacheBytes?: number;
  maxCachedScenes?: number;
  background?: string;
}

export class XpsRenderer {
  private wasm?: WasmRasterBackend;
  private webgl?: WebGlXpsBackend;
  private webglCanvas?: HTMLCanvasElement;
  private readonly fontCache = new Map<string, Promise<string | undefined>>();
  private readonly xmlCache = new Map<string, Promise<Document>>();

  constructor(private readonly document: LoadedDwfDocument) {}

  async render(page: XpsPageData, canvas: HTMLCanvasElement, options: XpsRenderOptions = {}): Promise<RenderStats> {
    const opc = this.document.opc;
    if (!opc) throw new Error('XPS page requires an OPC package view.');
    const warnings: Diagnostic[] = actionableDiagnostics(page.diagnostics);
    const doc = await this.getXmlDocument(page.sourcePath);
    const root = doc.documentElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('CanvasRenderingContext2D is not available.');

    const bg = options.background ?? '#ffffff';
    const runtime = { dpr: canvasDpr(canvas), zoom: options.zoom ?? 1 };
    const pageMatrix = fitPageMatrix({ canvasWidth: canvas.width, canvasHeight: canvas.height, pageWidth: page.width, pageHeight: page.height, zoom: options.zoom, panX: options.panX, panY: options.panY });
    let commands = 0;

    if (options.preferWebgl ?? true) {
      try {
        const backend = this.getWebGlBackend(options.webglCanvas);
        if (options.webglCanvas) options.webglCanvas.style.visibility = 'visible';
        const stats = backend.render(page, root, canvas, { ...options, compositeToTarget: !options.webglCanvas });
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        commands += stats.commands;
        commands += await this.renderElementToCanvas(root, ctx, page.sourcePath, pageMatrix, 1, warnings, { vectors: false, overlays: true }, options, runtime);
        warnings.push(...stats.warnings);
        return { backend: 'webgl-xps', commands, warnings };
      } catch (err) {
        if (options.webglCanvas) options.webglCanvas.style.visibility = 'hidden';
        warnings.push(diag('warning', 'WEBGL_XPS_BACKEND_FALLBACK', `WebGL XPS vector path failed, falling back to ${options.preferWasm ? 'WASM raster' : 'Canvas2D'}: ${String(err)}`, page.sourcePath));
      }
    }

    if (options.webglCanvas) options.webglCanvas.style.visibility = 'hidden';
    if (options.preferWasm) {
      try {
        this.wasm ??= new WasmRasterBackend({ wasmUrl: options.wasmUrl });
        await this.wasm.init();
        this.wasm.begin(canvas.width, canvas.height, bg);
        commands += this.renderElementToWasm(root, pageMatrix, 1, warnings, options, runtime);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.putImageData(this.wasm.toImageData(), 0, 0);
        commands += await this.renderElementToCanvas(root, ctx, page.sourcePath, pageMatrix, 1, warnings, { vectors: false, overlays: true }, options, runtime);
        return { backend: 'wasm-raster', commands, warnings };
      } catch (err) {
        warnings.push(diag('warning', 'WASM_BACKEND_FALLBACK', `WASM raster path failed, falling back to Canvas2D: ${String(err)}`));
      }
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    commands += await this.renderElementToCanvas(root, ctx, page.sourcePath, pageMatrix, 1, warnings, { vectors: true, overlays: true }, options, runtime);
    return { backend: 'canvas2d', commands, warnings };
  }


  private getWebGlBackend(canvas?: HTMLCanvasElement): WebGlXpsBackend {
    if (!this.webgl || this.webglCanvas !== canvas) {
      this.webgl?.dispose();
      this.webgl = new WebGlXpsBackend(canvas);
      this.webglCanvas = canvas;
    }
    return this.webgl;
  }

  private getXmlDocument(part: string): Promise<Document> {
    let cached = this.xmlCache.get(part);
    if (!cached) {
      const opc = this.document.opc!;
      cached = opc.readText(part).then(xml => parseXml(xml, part));
      this.xmlCache.set(part, cached);
    }
    return cached;
  }

  dispose(): void {
    this.webgl?.dispose();
    this.webgl = undefined;
    this.webglCanvas = undefined;
    this.xmlCache.clear();
    this.fontCache.clear();
  }

  private async renderElementToCanvas(
    el: Element,
    ctx: CanvasRenderingContext2D,
    pagePath: string,
    matrix: Matrix2D,
    opacity: number,
    warnings: Diagnostic[],
    mode: { vectors: boolean; overlays: boolean },
    options: XpsRenderOptions,
    runtime: { dpr: number; zoom: number }
  ): Promise<number> {
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
        const bounds = pathBounds(path);
        if (fill && shouldDrawFilledBounds(bounds, composed, options, runtime)) { ctx.fillStyle = fill; ctx.fill(fillRule(el)); }
        if (stroke && thickness > 0) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = adaptiveStrokeUserWidth(thickness, composed, options, runtime);
          applyStrokeStyle(ctx, el, ctx.lineWidth);
          ctx.stroke();
        }
        ctx.restore();
        commands++;
      }
    } else if (name === 'Glyphs' && mode.overlays) {
      commands += await this.drawGlyphs(ctx, pagePath, el, composed, ownOpacity, warnings, options, runtime);
    } else if (name === 'Image' && mode.overlays) {
      const source = getAttr(el, 'Source') ?? getAttr(el, 'ImageSource');
      if (source) {
        try {
          await this.drawImageResource(ctx, pagePath, source, composed, ownOpacity, el);
          commands++;
        } catch (err) {
          warnings.push(diag('warning', 'XPS_IMAGE_DRAW_FAILED', `Failed to draw image ${source}: ${String(err)}`, pagePath));
        }
      }
    } else if (name === 'Canvas' || name === 'FixedPage' || name.endsWith('.RenderTransform') || name.endsWith('.Resources')) {
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
        } catch (err) {
          warnings.push(diag('warning', 'XPS_IMAGEBRUSH_FAILED', `Failed to draw ImageBrush ${imageSource}: ${String(err)}`, pagePath));
        }
      }
    }

    for (const child of childElements(el)) {
      const childName = localName(child);
      if (childName.includes('.')) continue;
      commands += await this.renderElementToCanvas(child, ctx, pagePath, composed, ownOpacity, warnings, mode, options, runtime);
    }
    return commands;
  }

  private renderElementToWasm(el: Element, matrix: Matrix2D, opacity: number, warnings: Diagnostic[], options: XpsRenderOptions, runtime: { dpr: number; zoom: number }): number {
    if (!this.wasm) return 0;
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
        const screenThickness = adaptiveStrokeUserWidth(thickness, composed, options, runtime) * Math.max(1e-12, Math.hypot(composed.a, composed.b));
        const subs = flattenPath(path, 0.5);
        if (fill) {
          for (const sub of subs) if (sub.closed || sub.points.length >= 6) this.wasm.drawPolygon(sub.points, composed, fill);
        }
        if (stroke && thickness > 0) {
          for (const sub of subs) this.wasm.drawPolyline(sub.points, composed, stroke, screenThickness);
        }
        commands++;
      }
    }

    for (const child of childElements(el)) {
      const childName = localName(child);
      if (childName.includes('.')) continue;
      commands += this.renderElementToWasm(child, composed, ownOpacity, warnings, options, runtime);
    }
    return commands;
  }

  private async drawGlyphs(
    ctx: CanvasRenderingContext2D,
    pagePath: string,
    el: Element,
    matrix: Matrix2D,
    opacity: number,
    warnings: Diagnostic[],
    options: XpsRenderOptions,
    runtime: { dpr: number; zoom: number }
  ): Promise<number> {
    const text = getAttr(el, 'UnicodeString') ?? '';
    if (!text) return 0;
    const x = Number(getAttr(el, 'OriginX') ?? 0);
    const y = Number(getAttr(el, 'OriginY') ?? 0);
    const size = Number(getAttr(el, 'FontRenderingEmSize') ?? 12);
    if (!shouldDrawTextByPixelSize(size, matrix, options, runtime)) return 0;
    const fill = extractBrush(el, 'Fill', opacity) ?? '#000000';
    const family = await this.fontFamilyForGlyphs(pagePath, el, warnings) ?? 'sans-serif';
    ctx.save();
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.globalAlpha = opacity;
    ctx.fillStyle = fill;
    ctx.font = `${size}px "${family}"`;
    ctx.textBaseline = 'alphabetic';
    const indices = getAttr(el, 'Indices');
    if (indices) drawGlyphRunWithIndices(ctx, text, indices, x, y, size);
    else ctx.fillText(text, x, y);
    ctx.restore();
    return 1;
  }

  private async fontFamilyForGlyphs(pagePath: string, el: Element, warnings: Diagnostic[]): Promise<string | undefined> {
    const uri = getAttr(el, 'FontUri');
    if (!uri) return undefined;
    const part = resolvePagePart(this.document.opc!, pagePath, uri);
    // XPS/DWFx often stores embedded TrueType fonts as ODTTF.
    // Deobfuscate and load them so overview text matches CAD viewers instead
    // of falling back to thick system fonts.
    let cached = this.fontCache.get(part);
    if (!cached) {
      cached = this.loadFontFace(part).catch(err => {
        warnings.push(diag('warning', 'XPS_FONT_LOAD_FAILED', `Failed to load embedded XPS font ${part}: ${String(err)}`, pagePath));
        return undefined;
      });
      this.fontCache.set(part, cached);
    }
    return cached;
  }

  private async loadFontFace(part: string): Promise<string | undefined> {
    const FontFaceCtor = (globalThis as unknown as { FontFace?: new (family: string, source: string) => { load(): Promise<unknown> } }).FontFace;
    const fontSet = (document as unknown as { fonts?: { add(face: unknown): void } }).fonts;
    if (!FontFaceCtor || !fontSet) return undefined;
    let bytes = await this.document.opc!.readBytes(part);
    let mime = mimeFromPath(part) ?? 'font/ttf';
    if (/\.odttf$/i.test(part)) {
      bytes = deobfuscateOdttf(part, bytes);
      mime = 'font/ttf';
    }
    const family = `dwfv_xps_${hashString(part)}`;
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const face = new FontFaceCtor(family, `url("${url}")`);
    try {
      await face.load();
      fontSet.add(face);
      URL.revokeObjectURL(url);
      return family;
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  private async drawImageResource(ctx: CanvasRenderingContext2D, pagePath: string, source: string, matrix: Matrix2D, opacity: number, el: Element): Promise<void> {
    const opc = this.document.opc!;
    const src = resolvePagePart(opc, pagePath, source);
    const bytes = await opc.readBytes(src);
    const image = await blobToImage(bytes, opc.getContentType(src) ?? mimeFromPath(src) ?? 'image/png');
    const width = Number(getAttr(el, 'Width') ?? ('width' in image ? image.width : 0));
    const height = Number(getAttr(el, 'Height') ?? ('height' in image ? image.height : 0));
    const x = Number(getAttr(el, 'Canvas.Left') ?? getAttr(el, 'X') ?? 0);
    const y = Number(getAttr(el, 'Canvas.Top') ?? getAttr(el, 'Y') ?? 0);
    ctx.save();
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.globalAlpha = opacity;
    ctx.drawImage(image, x, y, width || (image as HTMLImageElement).width, height || (image as HTMLImageElement).height);
    ctx.restore();
  }

  private async drawImageBrush(ctx: CanvasRenderingContext2D, pagePath: string, source: string, matrix: Matrix2D, opacity: number, pathEl: Element, brushEl: Element): Promise<void> {
    const opc = this.document.opc!;
    const src = resolvePagePart(opc, pagePath, source);
    const bytes = await opc.readBytes(src);
    const image = await blobToImage(bytes, opc.getContentType(src) ?? mimeFromPath(src) ?? 'image/png');
    const viewport = parseRect(getAttr(brushEl, 'Viewport')) ?? parseRect(getAttr(brushEl, 'Viewbox')) ?? [0, 0, Number((image as HTMLImageElement).width ?? 1), Number((image as HTMLImageElement).height ?? 1)];
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

function applyStrokeStyle(ctx: CanvasRenderingContext2D, el: Element, userLineWidth: number): void {
  const start = (getAttr(el, 'StrokeStartLineCap') ?? '').toLowerCase();
  const end = (getAttr(el, 'StrokeEndLineCap') ?? '').toLowerCase();
  const dashCap = (getAttr(el, 'StrokeDashCap') ?? '').toLowerCase();
  if (start === 'round' || end === 'round' || dashCap === 'round') ctx.lineCap = 'round';
  else if (start === 'square' || end === 'square' || dashCap === 'square') ctx.lineCap = 'square';
  else ctx.lineCap = 'butt';

  const join = (getAttr(el, 'StrokeLineJoin') ?? '').toLowerCase();
  ctx.lineJoin = join === 'round' ? 'round' : join === 'bevel' ? 'bevel' : 'miter';
  const miter = Number(getAttr(el, 'StrokeMiterLimit') ?? 10);
  if (Number.isFinite(miter) && miter > 0) ctx.miterLimit = miter;

  const dash = parseNumberList(getAttr(el, 'StrokeDashArray') ?? '');
  if (dash.length > 0) {
    const offset = Number(getAttr(el, 'StrokeDashOffset') ?? 0);
    ctx.setLineDash(dash.map(v => Math.max(0, v * userLineWidth)));
    ctx.lineDashOffset = Number.isFinite(offset) ? offset * userLineWidth : 0;
  } else {
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
}

function pathBounds(commands: PathCommand[]): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const c of commands) {
    if (c.type === 'M' || c.type === 'L') add(c.x, c.y);
    else if (c.type === 'C') { add(c.x1, c.y1); add(c.x2, c.y2); add(c.x, c.y); }
    else if (c.type === 'Q') { add(c.x1, c.y1); add(c.x, c.y); }
    else if (c.type === 'A') { add(c.x - c.rx, c.y - c.ry); add(c.x + c.rx, c.y + c.ry); }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}

function drawGlyphRunWithIndices(ctx: CanvasRenderingContext2D, text: string, indices: string, x: number, y: number, emSize: number): void {
  const specs = indices.split(';');
  let cursor = x;
  let charIndex = 0;
  for (const spec of specs) {
    const raw = spec.trim();
    if (!raw) continue;
    const parts = raw.split(',');
    const advance = Number(parts[1] ?? '');
    const dx = Number(parts[3] ?? 0);
    const dy = Number(parts[4] ?? 0);
    const ch = text[charIndex++] ?? '';
    if (ch) ctx.fillText(ch, cursor + (Number.isFinite(dx) ? dx : 0), y + (Number.isFinite(dy) ? dy : 0));
    if (Number.isFinite(advance) && advance > 0) cursor += advance * emSize / 100;
    else cursor += ctx.measureText(ch || ' ').width;
  }
  if (charIndex < text.length) ctx.fillText(text.slice(charIndex), cursor, y);
}

function deobfuscateOdttf(part: string, bytes: Uint8Array): Uint8Array {
  const name = part.split('/').pop() ?? '';
  const guid = name.replace(/\.odttf$/i, '').replace(/[^0-9a-fA-F]/g, '');
  if (guid.length !== 32 || bytes.length < 32) return bytes;
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = parseInt(guid.slice(i * 2, i * 2 + 2), 16);
  // XPS font obfuscation uses the GUID bytes in reverse order, repeated over
  // the first 32 bytes of the font payload.
  const out = new Uint8Array(bytes);
  for (let i = 0; i < Math.min(32, out.length); i++) out[i] = (out[i] ?? 0) ^ key[15 - (i % 16)]!;
  if (!looksLikeSfnt(out)) {
    // A few producers use the GUID binary/little-endian representation.  Try it
    // as a guarded fallback rather than silently returning a broken font.
    const altKey = guidLittleEndianBytes(guid);
    const alt = new Uint8Array(bytes);
    for (let i = 0; i < Math.min(32, alt.length); i++) alt[i] = (alt[i] ?? 0) ^ altKey[15 - (i % 16)]!;
    if (looksLikeSfnt(alt)) return alt;
  }
  return out;
}

function guidLittleEndianBytes(hex: string): Uint8Array {
  const b = new Uint8Array(16);
  const raw = new Uint8Array(16);
  for (let i = 0; i < 16; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  b[0] = raw[3]!; b[1] = raw[2]!; b[2] = raw[1]!; b[3] = raw[0]!;
  b[4] = raw[5]!; b[5] = raw[4]!;
  b[6] = raw[7]!; b[7] = raw[6]!;
  for (let i = 8; i < 16; i++) b[i] = raw[i]!;
  return b;
}

function looksLikeSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return tag === 'OTTO' || tag === 'true' || tag === 'typ1' || tag === 'ttcf' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0);
}

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function elementMatrix(el: Element): Matrix2D {
  let m = parseMatrix(getAttr(el, 'RenderTransform') ?? getAttr(el, 'Transform'));
  for (const child of childElements(el)) {
    const name = localName(child);
    if (name.endsWith('.RenderTransform') || name.endsWith('.Transform')) {
      const matrixEl = childElements(child).find(c => localName(c) === 'MatrixTransform');
      if (matrixEl) m = multiplyMatrix(m, parseMatrix(getAttr(matrixEl, 'Matrix')));
    }
  }
  const left = Number(getAttr(el, 'Canvas.Left') ?? 0);
  const top = Number(getAttr(el, 'Canvas.Top') ?? 0);
  if (left || top) m = multiplyMatrix({ a: 1, b: 0, c: 0, d: 1, e: left, f: top }, m);
  return m;
}

function extractPathCommands(pathEl: Element): PathCommand[] {
  const data = getAttr(pathEl, 'Data');
  if (data) return parsePathData(data);
  for (const prop of childElements(pathEl)) {
    if (localName(prop) !== 'Path.Data') continue;
    for (const geom of childElements(prop)) {
      const figures = getAttr(geom, 'Figures');
      if (figures) return parsePathData(figures);
      if (localName(geom) === 'PathGeometry') {
        const built = buildPathGeometry(geom);
        if (built) return parsePathData(built);
      }
    }
  }
  return [];
}

function buildPathGeometry(geom: Element): string | undefined {
  const parts: string[] = [];
  for (const figure of childElements(geom).filter(e => localName(e) === 'PathFigure')) {
    const start = parseNumberList(getAttr(figure, 'StartPoint') ?? '');
    if (start.length >= 2) parts.push(`M ${start[0]} ${start[1]}`);
    for (const seg of childElements(figure)) {
      const name = localName(seg);
      if (name === 'LineSegment') {
        const p = parseNumberList(getAttr(seg, 'Point') ?? '');
        if (p.length >= 2) parts.push(`L ${p[0]} ${p[1]}`);
      } else if (name === 'PolyLineSegment') {
        const nums = parseNumberList(getAttr(seg, 'Points') ?? '');
        for (let i = 0; i + 1 < nums.length; i += 2) parts.push(`L ${nums[i]} ${nums[i + 1]}`);
      } else if (name === 'BezierSegment') {
        const nums = parseNumberList(getAttr(seg, 'Point1') + ' ' + getAttr(seg, 'Point2') + ' ' + getAttr(seg, 'Point3'));
        if (nums.length >= 6) parts.push(`C ${nums.slice(0, 6).join(' ')}`);
      } else if (name === 'PolyBezierSegment') {
        const nums = parseNumberList(getAttr(seg, 'Points') ?? '');
        for (let i = 0; i + 5 < nums.length; i += 6) parts.push(`C ${nums.slice(i, i + 6).join(' ')}`);
      }
    }
    if (getAttr(figure, 'IsClosed') === 'true') parts.push('Z');
  }
  return parts.length ? parts.join(' ') : undefined;
}

function extractBrush(el: Element, prop: 'Fill' | 'Stroke', opacity: number): string | undefined {
  const direct = getAttr(el, prop);
  if (direct) return parseBrushColor(direct, opacity);
  const solid = findPropertyBrush(el, prop, 'SolidColorBrush');
  if (solid) return parseBrushColor(getAttr(solid, 'Color'), opacity * parseOpacity(getAttr(solid, 'Opacity')));
  return undefined;
}

function findPropertyBrush(el: Element, prop: string, brushLocalName: string): Element | undefined {
  const propName = `${localName(el)}.${prop}`;
  for (const child of childElements(el)) {
    if (localName(child) !== propName) continue;
    return childElements(child).find(c => localName(c) === brushLocalName);
  }
  return undefined;
}

function parseOpacity(value?: string): number {
  if (!value) return 1;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function fillRule(el: Element): CanvasFillRule {
  const data = getAttr(el, 'Data') ?? '';
  return /F0/.test(data) ? 'nonzero' : 'evenodd';
}

function parseRect(s?: string): [number, number, number, number] | undefined {
  if (!s) return undefined;
  const nums = parseNumberList(s);
  if (nums.length >= 4) return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
  return undefined;
}

/**
 * An absolute part name ('/...', an ImageSource or FontUri) names a part from the package root. Writers that put a
 * leading slash on a page-relative name still resolve against the page's folder.
 */
function resolvePagePart(opc: OpcPackageView, pagePath: string, source: string): string {
  const absolute = resolvePart(pagePath, source);
  if (!source.startsWith('/') || opc.zip.has(absolute)) return absolute;
  const relative = resolvePart(pagePath, source.replace(/^\//, ''));
  return opc.zip.has(relative) ? relative : absolute;
}
