import { openDwfDocument } from '../format/open.js';
import type { LoadedDwfDocument, W3dSceneNodeData } from '../format/document.js';
import type { Matrix2D } from '../render/style.js';
import { transformPoint } from '../render/style.js';
import { fitPageMatrix, matrixForW2d } from '../render/viewport.js';
import type { PageRenderOptions, RenderStats } from '../format/types.js';
import { PageRenderer } from '../render/PageRenderer.js';

export interface DwfViewerOptions {
  wasmUrl?: string;
  lineWeightMode?: 'adaptive' | 'physical' | 'hairline';
  minStrokeCssPx?: number;
  maxOverviewStrokeCssPx?: number;
  minTextCssPx?: number;
  minFilledAreaCssPx?: number;
  preferWebgl?: boolean;
  preferWasm?: boolean;
  background?: string;
  maxDevicePixelRatio?: number;
  maxCanvasPixels?: number;
  maxGpuCacheBytes?: number;
  maxCachedScenes?: number;
}

export interface LoadOptions extends PageRenderOptions {
  fileName?: string;
}

export class DwfViewer {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly webglCanvas: HTMLCanvasElement;
  readonly pageSelect: HTMLSelectElement;
  readonly status: HTMLSpanElement;
  readonly treePanel: HTMLDivElement;
  private readonly zoomInButton: HTMLButtonElement;
  private readonly zoomOutButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private doc?: LoadedDwfDocument;
  private renderer?: PageRenderer;
  private pageIndex = 0;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private preferWebgl: boolean;
  private preferWasm: boolean;
  private wasmUrl?: string;
  private background: string;
  private maxDevicePixelRatio: number;
  private maxCanvasPixels: number;
  private maxGpuCacheBytes?: number;
  private maxCachedScenes?: number;
  private lineWeightMode: 'adaptive' | 'physical' | 'hairline';
  private minStrokeCssPx?: number;
  private maxOverviewStrokeCssPx?: number;
  private minTextCssPx?: number;
  private minFilledAreaCssPx?: number;
  private drag?: { x: number; y: number; panX: number; panY: number; yaw: number; pitch: number; mode: 'pan2d' | 'rotate3d' | 'pan3d' };
  private yaw = -0.78;
  private pitch = 0.55;
  private pendingRender?: Promise<RenderStats>;
  private rendering = false;
  private renderAgain = false;
  private renderRaf = 0;
  private renderSeq = 0;
  private currentDpr = 1;

  constructor(container: HTMLElement, options: DwfViewerOptions = {}) {
    this.preferWebgl = options.preferWebgl ?? true;
    this.preferWasm = options.preferWasm ?? true;
    this.wasmUrl = options.wasmUrl;
    this.background = options.background ?? '#ffffff';
    this.maxDevicePixelRatio = options.maxDevicePixelRatio ?? 2;
    this.maxCanvasPixels = options.maxCanvasPixels ?? 16_777_216;
    this.maxGpuCacheBytes = options.maxGpuCacheBytes;
    this.maxCachedScenes = options.maxCachedScenes;
    this.lineWeightMode = options.lineWeightMode ?? 'adaptive';
    this.minStrokeCssPx = options.minStrokeCssPx;
    this.maxOverviewStrokeCssPx = options.maxOverviewStrokeCssPx;
    this.minTextCssPx = options.minTextCssPx;
    this.minFilledAreaCssPx = options.minFilledAreaCssPx;

    this.root = document.createElement('div');
    this.root.className = 'dwfv-root';
    const toolbar = document.createElement('div');
    toolbar.className = 'dwfv-toolbar';
    this.pageSelect = document.createElement('select');
    this.zoomOutButton = button('−');
    this.zoomInButton = button('+');
    this.resetButton = button('适应');
    this.status = document.createElement('span');
    this.status.className = 'dwfv-status';
    toolbar.append('页: ', this.pageSelect, this.zoomOutButton, this.zoomInButton, this.resetButton, this.status);

    const workspace = document.createElement('div');
    workspace.className = 'dwfv-workspace';
    this.treePanel = document.createElement('div');
    this.treePanel.className = 'dwfv-tree';
    this.treePanel.style.display = 'none';
    const stage = document.createElement('div');
    stage.className = 'dwfv-stage';
    this.webglCanvas = document.createElement('canvas');
    this.webglCanvas.className = 'dwfv-canvas dwfv-webgl-canvas';
    this.webglCanvas.style.visibility = 'hidden';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dwfv-canvas dwfv-overlay-canvas';
    this.canvas.style.touchAction = 'none';
    stage.append(this.webglCanvas, this.canvas);
    workspace.append(this.treePanel, stage);
    this.root.append(toolbar, workspace);
    container.replaceChildren(this.root);

    this.pageSelect.addEventListener('change', () => { this.pageIndex = this.pageSelect.selectedIndex; this.resetView(); this.populateModelTree(); this.requestRender(); });
    this.zoomOutButton.addEventListener('click', () => { this.zoomAtCenter(0.8); this.requestRender(); });
    this.zoomInButton.addEventListener('click', () => { this.zoomAtCenter(1.25); this.requestRender(); });
    this.resetButton.addEventListener('click', () => { this.resetView(); this.requestRender(); });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => { this.drag = undefined; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    new ResizeObserver(() => this.requestRender()).observe(stage);
    this.setStatus('选择 .dwf/.dwfx 文件');
  }

  setPreferWebgl(value: boolean): void {
    this.preferWebgl = value;
    this.requestRender();
  }

  setPreferWasm(value: boolean): void {
    this.preferWasm = value;
    this.requestRender();
  }

  setLineWeightMode(value: 'adaptive' | 'physical' | 'hairline'): void {
    this.lineWeightMode = value;
    this.renderer?.dispose();
    this.requestRender();
  }

  async load(input: ArrayBuffer | Uint8Array | Blob | File, options: LoadOptions = {}): Promise<void> {
    this.setStatus('解析文件中…');
    this.renderer?.dispose();
    this.doc = await openDwfDocument(input, { fileName: options.fileName });
    this.renderer = new PageRenderer(this.doc);
    this.pageIndex = options.pageIndex ?? 0;
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.yaw = -0.78;
    this.pitch = 0.55;
    this.preferWebgl = options.preferWebgl ?? this.preferWebgl;
    this.preferWasm = options.preferWasm ?? this.preferWasm;
    this.wasmUrl = options.wasmUrl ?? this.wasmUrl;
    this.background = options.background ?? this.background;
    this.maxGpuCacheBytes = options.maxGpuCacheBytes ?? this.maxGpuCacheBytes;
    this.maxCachedScenes = options.maxCachedScenes ?? this.maxCachedScenes;
    this.lineWeightMode = options.lineWeightMode ?? this.lineWeightMode;
    this.minStrokeCssPx = options.minStrokeCssPx ?? this.minStrokeCssPx;
    this.maxOverviewStrokeCssPx = options.maxOverviewStrokeCssPx ?? this.maxOverviewStrokeCssPx;
    this.minTextCssPx = options.minTextCssPx ?? this.minTextCssPx;
    this.minFilledAreaCssPx = options.minFilledAreaCssPx ?? this.minFilledAreaCssPx;
    this.populatePages();
    this.populateModelTree();
    await this.render();
  }

  async render(): Promise<RenderStats | undefined> {
    if (!this.renderer || !this.doc) return undefined;
    if (this.rendering) {
      this.renderAgain = true;
      return this.pendingRender;
    }
    this.rendering = true;
    try {
      this.resizeCanvasToDisplaySize();
      const page = this.doc.pageData[this.pageIndex];
      if (!page) return undefined;
      const seq = ++this.renderSeq;
      const task = this.renderer.render(this.pageIndex, this.canvas, {
        zoom: this.zoom,
        panX: this.panX,
        panY: this.panY,
        preferWebgl: this.preferWebgl,
        preferWasm: this.preferWasm,
        wasmUrl: this.wasmUrl,
        background: this.background,
        maxGpuCacheBytes: this.maxGpuCacheBytes,
        maxCachedScenes: this.maxCachedScenes,
        webglCanvas: this.webglCanvas,
        yaw: this.yaw,
        pitch: this.pitch,
        lineWeightMode: this.lineWeightMode,
        minStrokeCssPx: this.minStrokeCssPx,
        maxOverviewStrokeCssPx: this.maxOverviewStrokeCssPx,
        minTextCssPx: this.minTextCssPx,
        minFilledAreaCssPx: this.minFilledAreaCssPx
      });
      this.pendingRender = task;
      try {
        const stats = await task;
        if (this.pendingRender === task && seq === this.renderSeq) {
          const warnCount = stats.warnings.filter(w => w.level !== 'info').length;
          const dprText = this.currentDpr > 1 ? ` · DPR ${this.currentDpr.toFixed(2)}` : '';
          this.setStatus(`${this.doc.kind.toUpperCase()} · ${page.kind} · ${stats.backend} · ${stats.commands} ops${dprText}${warnCount ? ` · ${warnCount} 警告` : ''}`, warnCount > 0);
        }
        return stats;
      } catch (err) {
        if (seq === this.renderSeq) this.setStatus(`渲染失败：${String(err)}`, true);
        throw err;
      }
    } finally {
      this.rendering = false;
      if (this.renderAgain) {
        this.renderAgain = false;
        this.requestRender();
      }
    }
  }

  getDocument(): LoadedDwfDocument | undefined {
    return this.doc;
  }

  fit(): void {
    this.resetView();
    this.requestRender();
  }

  dispose(): void {
    if (this.renderRaf) cancelAnimationFrame(this.renderRaf);
    this.renderRaf = 0;
    this.renderer?.dispose();
    this.renderer = undefined;
    this.doc = undefined;
    this.root.replaceChildren();
  }

  private requestRender(): void {
    if (this.renderRaf) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = 0;
      void this.render();
    });
  }

  private populatePages(): void {
    this.pageSelect.replaceChildren();
    const pages = this.doc?.pageData ?? [];
    for (const [i, p] of pages.entries()) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${i + 1}. ${p.name} (${p.kind})`;
      this.pageSelect.append(opt);
    }
    this.pageSelect.selectedIndex = Math.max(0, Math.min(this.pageIndex, pages.length - 1));
  }


  private populateModelTree(): void {
    const page = this.doc?.pageData[this.pageIndex];
    if (!page || page.kind !== 'w3d-model' || !(page.model.sceneTree?.length)) {
      this.treePanel.style.display = 'none';
      this.treePanel.replaceChildren();
      return;
    }
    this.treePanel.style.display = '';
    const header = document.createElement('div');
    header.className = 'dwfv-tree-header';
    header.textContent = `模型结构 · ${page.model.stats.nodeCount ?? 0} 节点`;
    const stats = document.createElement('div');
    stats.className = 'dwfv-tree-stats';
    stats.textContent = `${page.model.stats.meshCount} meshes · ${page.model.stats.triangleCount} triangles · ${(page.model.stats.textureCount ?? 0)} textures`;
    const content = document.createElement('div');
    content.className = 'dwfv-tree-content';
    for (const node of page.model.sceneTree) content.append(renderTreeNode(node));
    this.treePanel.replaceChildren(header, stats, content);
  }

  private resizeCanvasToDisplaySize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    let dpr = Math.max(1, Math.min(this.maxDevicePixelRatio, window.devicePixelRatio || 1));
    const pixels = cssW * cssH * dpr * dpr;
    if (pixels > this.maxCanvasPixels) dpr *= Math.sqrt(this.maxCanvasPixels / pixels);
    this.currentDpr = dpr;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.webglCanvas.width !== w || this.webglCanvas.height !== h) {
      this.webglCanvas.width = w;
      this.webglCanvas.height = h;
    }
  }

  private resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.yaw = -0.78;
    this.pitch = 0.55;
    const page = this.doc?.pageData[this.pageIndex];
    if (page?.kind === 'w3d-model') {
      const cam = page.model.initialView?.camera;
      const pos = cam?.position;
      const target = cam?.target;
      if (pos && target) {
        const dx = pos[0] - target[0];
        const dy = pos[1] - target[1];
        const dz = pos[2] - target[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 1e-6) {
          this.pitch = Math.max(-1.45, Math.min(1.45, Math.asin(dy / dist)));
          this.yaw = Math.atan2(dx, dz);
          const radius = Math.max(1e-6, page.model.bounds.radius);
          this.zoom = Math.max(0.05, Math.min(100, radius * 2.55 / dist));
        }
      }
    }
  }

  private zoomAtCenter(factor: number): void {
    this.resizeCanvasToDisplaySize();
    if (this.is3dPage()) {
      this.zoom = Math.max(0.05, Math.min(100, this.zoom * factor));
      return;
    }
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    this.zoomAroundPoint(factor, cx, cy);
  }

  private zoomAroundPoint(factor: number, cx: number, cy: number): void {
    const oldZoom = this.zoom;
    const nextZoom = Math.max(0.05, Math.min(64, oldZoom * factor));
    if (nextZoom === oldZoom) return;

    // Keep the drawing coordinate under the cursor fixed.  A simple
    // `pan = cursor - (cursor - pan) * ratio` is wrong for fit-to-page
    // transforms, because the fit center also changes with zoom.
    const anchoredPoint = this.pagePointAtCanvasPoint(cx, cy, oldZoom, this.panX, this.panY);
    if (anchoredPoint) {
      const baseMatrix = this.pageMatrixAt(nextZoom, 0, 0);
      if (baseMatrix) {
        const [sx, sy] = transformPoint(baseMatrix, anchoredPoint.x, anchoredPoint.y);
        this.panX = cx - sx;
        this.panY = cy - sy;
        this.zoom = nextZoom;
        return;
      }
    }

    // Generic fallback for unsupported page kinds.
    const ratio = nextZoom / oldZoom;
    this.panX = cx - (cx - this.panX) * ratio;
    this.panY = cy - (cy - this.panY) * ratio;
    this.zoom = nextZoom;
  }

  private onWheel(e: WheelEvent): void {
    if (!this.doc) return;
    e.preventDefault();
    this.resizeCanvasToDisplaySize();
    const rect = this.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * this.currentDpr;
    const cy = (e.clientY - rect.top) * this.currentDpr;
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? e.deltaY * 16
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? e.deltaY * Math.max(1, rect.height)
        : e.deltaY;
    const factor = Math.exp(-delta * 0.0015);
    if (this.is3dPage()) this.zoom = Math.max(0.05, Math.min(100, this.zoom * factor));
    else this.zoomAroundPoint(factor, cx, cy);
    this.requestRender();
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture?.(e.pointerId);
    if (this.is3dPage()) e.preventDefault();
    const mode = this.is3dPage() ? ((e.button === 2 || e.shiftKey) ? 'pan3d' : 'rotate3d') : 'pan2d';
    this.drag = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY, yaw: this.yaw, pitch: this.pitch, mode };
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    if (this.drag.mode === 'rotate3d') {
      this.yaw = this.drag.yaw + dx * 0.008;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.drag.pitch + dy * 0.008));
    } else {
      this.panX = this.drag.panX + dx * this.currentDpr;
      this.panY = this.drag.panY + dy * this.currentDpr;
    }
    this.requestRender();
  }


  private is3dPage(): boolean {
    const page = this.doc?.pageData[this.pageIndex];
    return page?.kind === 'w3d-model';
  }

  private pagePointAtCanvasPoint(cx: number, cy: number, zoom: number, panX: number, panY: number): { x: number; y: number } | undefined {
    const m = this.pageMatrixAt(zoom, panX, panY);
    if (!m) return undefined;
    const det = m.a * m.d - m.b * m.c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
    const dx = cx - m.e;
    const dy = cy - m.f;
    return {
      x: (m.d * dx - m.c * dy) / det,
      y: (-m.b * dx + m.a * dy) / det
    };
  }

  private pageMatrixAt(zoom: number, panX: number, panY: number): Matrix2D | undefined {
    const page = this.doc?.pageData[this.pageIndex];
    if (!page) return undefined;
    const canvasWidth = Math.max(1, this.canvas.width);
    const canvasHeight = Math.max(1, this.canvas.height);
    if (page.kind === 'w2d-text') return matrixForW2d(page, canvasWidth, canvasHeight, zoom, panX, panY);
    if (page.kind === 'xps-fixed-page') {
      return fitPageMatrix({
        canvasWidth,
        canvasHeight,
        pageWidth: Math.max(1, page.width),
        pageHeight: Math.max(1, page.height),
        zoom,
        panX,
        panY
      });
    }
    if (page.kind === 'image') {
      return fitPageMatrix({
        canvasWidth,
        canvasHeight,
        pageWidth: Math.max(1, page.width),
        pageHeight: Math.max(1, page.height),
        zoom,
        panX,
        panY,
        margin: 0
      });
    }
    return undefined;
  }

  private setStatus(text: string, warn = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('dwfv-warn', warn);
  }
}

function button(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  return b;
}


function renderTreeNode(node: W3dSceneNodeData): HTMLElement {
  const details = document.createElement('details');
  details.open = node.children.length > 0 && node.children.length < 20;
  const summary = document.createElement('summary');
  summary.textContent = node.label || node.id;
  if (node.meshIds.length > 0) summary.title = `${node.meshIds.length} mesh(es)`;
  details.append(summary);
  if (node.contentRefs.length > 0) {
    const meta = document.createElement('div');
    meta.className = 'dwfv-tree-meta';
    meta.textContent = node.contentRefs.slice(0, 3).join(', ');
    details.append(meta);
  }
  for (const child of node.children) details.append(renderTreeNode(child));
  return details;
}
