import { DwfViewer as BaseDwfViewer } from './DwfViewerBase.js';
import type {
  DwfViewerOptions as BaseDwfViewerOptions,
  LoadOptions as BaseLoadOptions
} from './DwfViewerBase.js';
import type { LoadedDwfDocument } from '../format/document.js';
import type { RenderStats } from '../format/types.js';
import type { PageRenderer } from '../render/PageRenderer.js';
import { applyXpsContrastXml, contrastPolicyKey, createContrastPage, type ColorContrastOptions } from '../render/contrast.js';
import {
  applyXpsMonochromeXml,
  createMonochromePage,
  normalizeMonochromeColor
} from '../render/monochrome.js';

export interface DwfViewerOptions extends BaseDwfViewerOptions, ColorContrastOptions {
  /**
   * Overrides vector, text and model-material colors with one fixed color.
   * Images, page background, geometry, line weights and opacity are preserved.
   * Omit the value to render source colors.
   */
  monochromeColor?: string;
}

export interface LoadOptions extends BaseLoadOptions, ColorContrastOptions {
  /** Per-load override for the viewer's monochrome color. */
  monochromeColor?: string;
}

interface DwfViewerInternals {
  doc?: LoadedDwfDocument;
  renderer?: PageRenderer;
  pageIndex: number;
  rendering: boolean;
  background: string;
  requestRender(): void;
}

/**
 * Adds a non-destructive monochrome plot-style view on top of the native DWF
 * renderer. The parsed document remains source-colored for metadata consumers.
 */
export class DwfViewer extends BaseDwfViewer {
  private monochromeColor?: string;
  private preparedRenderer?: PageRenderer;
  private preparedColor?: string;
  private contrastOptions: ColorContrastOptions;

  constructor(container: HTMLElement, options: DwfViewerOptions = {}) {
    super(container, options);
    this.monochromeColor = normalizeMonochromeColor(options.monochromeColor);
    this.contrastOptions = { contrastMode: options.contrastMode, minColorContrast: options.minColorContrast };
  }

  override async load(
    input: ArrayBuffer | Uint8Array | Blob | File,
    options: LoadOptions = {}
  ): Promise<void> {
    if (Object.prototype.hasOwnProperty.call(options, 'monochromeColor')) {
      this.updateMonochromeColor(options.monochromeColor, false);
    }
    if (options.contrastMode !== undefined) this.contrastOptions.contrastMode = options.contrastMode;
    if (options.minColorContrast !== undefined) this.contrastOptions.minColorContrast = options.minColorContrast;
    await super.load(input, options);
  }

  /** Switches between source colors (undefined) and a fixed plot color. */
  setMonochromeColor(value?: string): void {
    this.updateMonochromeColor(value, true);
  }

  getMonochromeColor(): string | undefined {
    return this.monochromeColor;
  }

  setContrastOptions(options: Pick<ColorContrastOptions, 'contrastMode' | 'minColorContrast'>): void {
    this.contrastOptions = { ...this.contrastOptions, ...options };
    (this as unknown as DwfViewerInternals).requestRender();
  }

  override async render(): Promise<RenderStats | undefined> {
    const internals = this as unknown as DwfViewerInternals;

    // Let the base viewer coalesce a concurrent request. Mutating pageData while
    // an existing render is active would otherwise make cache invalidation race.
    if (internals.rendering) return super.render();

    const renderer = internals.renderer;
    const color = this.monochromeColor;
    const contrast = { ...this.contrastOptions, background: internals.background };
    const policy = color || contrastPolicyKey(contrast);
    if (renderer) {
      if (this.preparedRenderer === renderer && this.preparedColor !== policy) {
        renderer.dispose();
      }
      this.preparedRenderer = renderer;
      this.preparedColor = policy;
    }

    const doc = internals.doc;
    const pageIndex = internals.pageIndex;
    const sourcePage = doc?.pageData[pageIndex];
    if ((!color && contrast.contrastMode !== 'adaptive') || !doc || !sourcePage) return super.render();

    const renderedPage = color ? createMonochromePage(sourcePage, color) : createContrastPage(sourcePage, contrast);
    doc.pageData[pageIndex] = renderedPage;

    const opc = doc.opc;
    const sourceReadText = opc?.readText;
    if (opc && sourceReadText) {
      opc.readText = async (path: string) => {
        const xml = await sourceReadText.call(opc, path);
        return color ? applyXpsMonochromeXml(xml, color) : applyXpsContrastXml(xml, contrast);
      };
    }

    try {
      return await super.render();
    } finally {
      if (doc.pageData[pageIndex] === renderedPage) doc.pageData[pageIndex] = sourcePage;
      if (opc && sourceReadText) opc.readText = sourceReadText;
    }
  }

  override dispose(): void {
    this.preparedRenderer = undefined;
    this.preparedColor = undefined;
    super.dispose();
  }

  private updateMonochromeColor(value: string | undefined, requestRender: boolean): void {
    const normalized = normalizeMonochromeColor(value);
    if (normalized === this.monochromeColor) return;
    this.monochromeColor = normalized;
    if (requestRender) (this as unknown as DwfViewerInternals).requestRender();
  }
}
