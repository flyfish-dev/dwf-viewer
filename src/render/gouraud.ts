import { colorToRgba32 } from './style.js';

export const MAX_CANVAS_GOURAUD_PIXELS = 4_000_000;

export function gouraudRasterBounds(points: number[], canvasWidth: number, canvasHeight: number): { x: number; y: number; width: number; height: number } | undefined {
  if (points.length !== 6 || !points.every(Number.isFinite) || !Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight)) return undefined;
  const [ax, ay, bx, by, cx, cy] = points as [number, number, number, number, number, number];
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-9) return undefined;
  const x = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const y = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const width = Math.min(canvasWidth, Math.ceil(Math.max(ax, bx, cx))) - x;
  const height = Math.min(canvasHeight, Math.ceil(Math.max(ay, by, cy))) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** Pixel-center sampling with top-left ownership avoids alpha seams between adjacent triangles. */
export function rasterizeGouraudTriangle(points: number[], colors: string[], canvasWidth: number, canvasHeight: number): {
  x: number; y: number; width: number; height: number; data: Uint8ClampedArray;
} | undefined {
  if (colors.length !== 3) return undefined;
  const bounds = gouraudRasterBounds(points, canvasWidth, canvasHeight);
  if (!bounds) return undefined;
  const { x, y, width, height } = bounds;
  if (width * height > MAX_CANVAS_GOURAUD_PIXELS) throw new Error('Canvas Gouraud pixel budget exceeded. Use WebGL or reduce the viewport.');
  let [ax, ay, bx, by, cx, cy] = points as [number, number, number, number, number, number];
  let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area < 0) {
    [bx, by, cx, cy] = [cx, cy, bx, by];
    colors = [colors[0]!, colors[2]!, colors[1]!];
    area = -area;
  }
  const rgba = colors.map(color => {
    const value = colorToRgba32(color, 0xff000000);
    return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
  });
  const topLeft = (x0: number, y0: number, x1: number, y1: number) => y1 < y0 || (y1 === y0 && x1 > x0);
  const bc = topLeft(bx, by, cx, cy), ca = topLeft(cx, cy, ax, ay), ab = topLeft(ax, ay, bx, by);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const px = x + col + 0.5, py = y + row + 0.5;
      const e0 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const e1 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      const e2 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (e0 < 0 || (e0 === 0 && !bc) || e1 < 0 || (e1 === 0 && !ca) || e2 < 0 || (e2 === 0 && !ab)) continue;
      const w0 = e0 / area, w1 = e1 / area, w2 = e2 / area;
      const offset = (row * width + col) * 4;
      for (let channel = 0; channel < 4; channel++) data[offset + channel] = w0 * rgba[0]![channel]! + w1 * rgba[1]![channel]! + w2 * rgba[2]![channel]!;
    }
  }
  return { x, y, width, height, data };
}

export function drawGouraudTriangle(ctx: CanvasRenderingContext2D, points: number[], colors: string[]): void {
  const raster = rasterizeGouraudTriangle(points, colors, ctx.canvas.width, ctx.canvas.height);
  if (!raster) return;
  const canvas = ctx.canvas.ownerDocument.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const buffer = canvas.getContext('2d');
  if (!buffer) throw new Error('CanvasRenderingContext2D is not available for Gouraud shading.');
  const image = buffer.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  buffer.putImageData(image, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(canvas, raster.x, raster.y);
  ctx.restore();
}
