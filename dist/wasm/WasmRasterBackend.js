import { colorToRgba32, transformPoint } from '../render/style.js';
export class WasmRasterBackend {
    constructor(options = {}) {
        this.fbPtr = 0;
        this.fbBytes = 0;
        this.width = 0;
        this.height = 0;
        this.wasmUrl = options.wasmUrl ?? './public/dwfv-render.wasm';
    }
    async init() {
        if (this.exports)
            return;
        const response = await fetch(this.wasmUrl);
        if (!response.ok)
            throw new Error(`Failed to load WASM raster backend: ${response.status} ${response.statusText}`);
        const bytes = await response.arrayBuffer();
        const instance = await WebAssembly.instantiate(bytes, {});
        this.exports = instance.instance.exports;
    }
    begin(width, height, backgroundCss = '#ffffff') {
        const e = this.requireExports();
        this.width = Math.max(1, Math.floor(width));
        this.height = Math.max(1, Math.floor(height));
        this.fbBytes = this.width * this.height * 4;
        e.dwfv_reset_heap();
        this.fbPtr = e.dwfv_alloc(this.fbBytes);
        this.ensureMemory(this.fbPtr + this.fbBytes);
        e.dwfv_clear(this.fbPtr, this.width, this.height, colorToRgba32(backgroundCss, 0xffffffff));
    }
    drawPolyline(points, matrix, strokeCss, thickness = 1) {
        const e = this.requireExports();
        if (points.length < 4 || !strokeCss)
            return;
        const count = Math.floor(points.length / 2);
        const ptr = this.allocF32(count * 2);
        const heap = new Float32Array(e.memory.buffer, ptr, count * 2);
        for (let i = 0; i < count; i++) {
            const [x, y] = transformPoint(matrix, points[i * 2], points[i * 2 + 1]);
            heap[i * 2] = x;
            heap[i * 2 + 1] = y;
        }
        e.dwfv_draw_polyline(this.fbPtr, this.width, this.height, ptr, count, colorToRgba32(strokeCss, 0xff000000), Math.max(1, thickness));
    }
    drawPolygon(points, matrix, fillCss) {
        const e = this.requireExports();
        if (points.length < 6 || !fillCss)
            return;
        const count = Math.floor(points.length / 2);
        const ptr = this.allocF32(count * 2);
        const heap = new Float32Array(e.memory.buffer, ptr, count * 2);
        for (let i = 0; i < count; i++) {
            const [x, y] = transformPoint(matrix, points[i * 2], points[i * 2 + 1]);
            heap[i * 2] = x;
            heap[i * 2 + 1] = y;
        }
        e.dwfv_draw_polygon(this.fbPtr, this.width, this.height, ptr, count, colorToRgba32(fillCss, 0xff000000));
    }
    toImageData() {
        const e = this.requireExports();
        const src = new Uint8ClampedArray(e.memory.buffer, this.fbPtr, this.fbBytes);
        // Clone out of wasm memory because future allocations can invalidate the buffer view.
        return new ImageData(new Uint8ClampedArray(src), this.width, this.height);
    }
    allocF32(floatCount) {
        const e = this.requireExports();
        const byteCount = floatCount * 4;
        const ptr = e.dwfv_alloc(byteCount);
        this.ensureMemory(ptr + byteCount);
        return ptr;
    }
    ensureMemory(requiredBytes) {
        const e = this.requireExports();
        const page = 65536;
        const current = e.memory.buffer.byteLength;
        if (requiredBytes > current) {
            e.memory.grow(Math.ceil((requiredBytes - current) / page));
        }
    }
    requireExports() {
        if (!this.exports)
            throw new Error('WASM backend is not initialized. Call init() first.');
        return this.exports;
    }
}
