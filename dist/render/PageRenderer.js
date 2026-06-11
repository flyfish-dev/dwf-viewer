import { actionableDiagnostics, diag } from '../format/types.js';
import { blobToImage } from '../format/util.js';
import { XpsRenderer } from './XpsRenderer.js';
import { W2dRenderer } from './W2dRenderer.js';
import { ThreeW3dRenderer } from './ThreeW3dRenderer.js';
export class PageRenderer {
    constructor(document) {
        this.document = document;
    }
    async render(pageIndex, canvas, options = {}) {
        const page = this.document.pageData[pageIndex];
        if (!page)
            throw new Error(`Page index out of range: ${pageIndex}`);
        if (page.kind !== 'w2d-text' && page.kind !== 'w3d-model' && options.webglCanvas)
            options.webglCanvas.style.visibility = 'hidden';
        if (page.kind === 'xps-fixed-page') {
            this.xps ?? (this.xps = new XpsRenderer(this.document));
            return await this.xps.render(page, canvas, options);
        }
        if (page.kind === 'w2d-text') {
            this.w2d ?? (this.w2d = new W2dRenderer());
            return await this.w2d.render(page, canvas, options);
        }
        if (page.kind === 'w3d-model') {
            this.w3d ?? (this.w3d = new ThreeW3dRenderer());
            return await this.w3d.render(page, canvas, options);
        }
        if (page.kind === 'image')
            return await this.renderImage(page, canvas, options);
        return this.renderUnsupported(page, canvas, options);
    }
    dispose() {
        this.w2d?.dispose();
        this.w3d?.dispose();
    }
    async renderImage(page, canvas, options) {
        const zip = this.document.zip;
        if (!zip)
            throw new Error('Image page requires a ZIP package.');
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('CanvasRenderingContext2D is not available.');
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = options.background ?? '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        const image = await blobToImage(await zip.read(page.sourcePath), page.mediaType);
        const iw = 'width' in image ? image.width : image.naturalWidth;
        const ih = 'height' in image ? image.height : image.naturalHeight;
        const scale = Math.min(canvas.width / Math.max(1, iw), canvas.height / Math.max(1, ih)) * (options.zoom ?? 1);
        const w = iw * scale, h = ih * scale;
        const x = (canvas.width - w) / 2 + (options.panX ?? 0);
        const y = (canvas.height - h) / 2 + (options.panY ?? 0);
        ctx.drawImage(image, x, y, w, h);
        return { backend: 'image', commands: 1, warnings: actionableDiagnostics(page.diagnostics) };
    }
    renderUnsupported(page, canvas, options) {
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('CanvasRenderingContext2D is not available.');
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = options.background ?? '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111827';
        ctx.font = '16px sans-serif';
        wrapText(ctx, page.name, 32, 48, canvas.width - 64, 24);
        ctx.font = '13px sans-serif';
        ctx.fillStyle = '#92400e';
        wrapText(ctx, page.reason, 32, 88, canvas.width - 64, 20);
        ctx.restore();
        return { backend: 'unsupported', commands: 0, warnings: [...page.diagnostics, diag('warning', 'PAGE_UNSUPPORTED', page.reason, page.sourcePath)] };
    }
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(/\s+/);
    let line = '';
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
            ctx.fillText(line, x, y);
            line = word;
            y += lineHeight;
        }
        else {
            line = test;
        }
    }
    if (line)
        ctx.fillText(line, x, y);
}
