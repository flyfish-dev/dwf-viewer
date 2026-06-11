export function fitPageMatrix(opts) {
    const margin = opts.margin ?? 24;
    const usableW = Math.max(1, opts.canvasWidth - margin * 2);
    const usableH = Math.max(1, opts.canvasHeight - margin * 2);
    const base = Math.min(usableW / Math.max(1, opts.pageWidth), usableH / Math.max(1, opts.pageHeight));
    const scale = base * (opts.zoom ?? 1);
    const e = (opts.canvasWidth - opts.pageWidth * scale) / 2 + (opts.panX ?? 0) - (opts.sourceMinX ?? 0) * scale;
    const f = (opts.canvasHeight - opts.pageHeight * scale) / 2 + (opts.panY ?? 0) - (opts.sourceMinY ?? 0) * scale;
    return { a: scale, b: 0, c: 0, d: scale, e, f };
}
export function matrixForW2d(page, canvasWidth, canvasHeight, zoom = 1, panX = 0, panY = 0) {
    const b = page.bounds;
    const minX = b?.minX ?? 0;
    const minY = b?.minY ?? 0;
    const maxY = b?.maxY ?? page.height;
    const pageWidth = b ? Math.max(1, b.maxX - b.minX) : page.width;
    const pageHeight = b ? Math.max(1, b.maxY - b.minY) : page.height;
    const margin = 24;
    const usableW = Math.max(1, canvasWidth - margin * 2);
    const usableH = Math.max(1, canvasHeight - margin * 2);
    const scale = Math.min(usableW / Math.max(1, pageWidth), usableH / Math.max(1, pageHeight)) * zoom;
    const left = (canvasWidth - pageWidth * scale) / 2 + panX;
    const top = (canvasHeight - pageHeight * scale) / 2 + panY;
    // Classic WHIP!/W2D logical coordinates use a mathematical Y-up orientation. Canvas uses Y-down,
    // so flip vertically while preserving fit-to-bounds.
    return { a: scale, b: 0, c: 0, d: -scale, e: left - minX * scale, f: top + maxY * scale };
}
