import { diag } from './types.js';
const FONT_NAME_BIT = 0x0001;
const FONT_CHARSET_BIT = 0x0002;
const FONT_PITCH_BIT = 0x0004;
const FONT_FAMILY_BIT = 0x0008;
const FONT_STYLE_BIT = 0x0010;
const FONT_HEIGHT_BIT = 0x0020;
const FONT_ROTATION_BIT = 0x0040;
const FONT_WIDTH_SCALE_BIT = 0x0080;
const FONT_SPACING_BIT = 0x0100;
const FONT_OBLIQUE_BIT = 0x0200;
const FONT_FLAGS_BIT = 0x0400;
export function parseW2dBinary(bytes, sourcePath) {
    const parser = new BinaryW2dParser(bytes, sourcePath);
    return parser.parse();
}
class BinaryW2dParser {
    constructor(bytes, sourcePath) {
        this.bytes = bytes;
        this.sourcePath = sourcePath;
        this.pos = 0;
        this.current = { x: 0, y: 0 };
        this.primitives = [];
        this.diagnostics = [];
        this.unsupportedOpcodes = [];
        this.opcodes = 0;
        this.decimalRevision = 600;
        this.state = {
            stroke: '#000000',
            fill: undefined,
            fillOn: false,
            visible: true,
            lineWidth: 1,
            fontHeight: 120,
            fontRotation: 0,
            fontName: 'sans-serif'
        };
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    parse() {
        while (this.pos < this.bytes.length) {
            this.eatWhitespace();
            if (this.pos >= this.bytes.length)
                break;
            const offset = this.pos;
            const opcode = this.u8();
            this.opcodes++;
            try {
                if (opcode === 0x28) { // '(', extended ASCII opcode/expression.
                    this.pos = offset;
                    this.parseExtendedAscii(offset);
                    continue;
                }
                if (opcode === 0x7b) { // '{', extended binary opcode.
                    if (!this.parseExtendedBinary(offset))
                        break;
                    continue;
                }
                if (this.parseSingleByteOpcode(opcode))
                    continue;
                this.unsupportedOpcodes.push({ offset, opcode, message: `Unsupported/unknown W2D single-byte opcode 0x${opcode.toString(16).padStart(2, '0')}.` });
                // Unknown single-byte opcodes usually imply an unsupported WHIP object and operand length is not knowable.
                // Stop rather than desynchronizing and producing corrupt geometry.
                break;
            }
            catch (err) {
                this.unsupportedOpcodes.push({ offset, opcode, message: `Failed while decoding W2D opcode 0x${opcode.toString(16)}: ${String(err)}` });
                break;
            }
        }
        if (this.primitives.length > 0) {
            this.diagnostics.push(diag('info', 'W2D_BINARY_PARSED', `Parsed ${this.primitives.length} vector primitives from binary WHIP!/W2D stream (${this.opcodes} opcodes).`, this.sourcePath));
        }
        else {
            this.diagnostics.push(diag('warning', 'W2D_BINARY_NO_GEOMETRY', 'Binary WHIP!/W2D parser did not emit supported geometry.', this.sourcePath));
        }
        if (this.unsupportedOpcodes.length > 0) {
            const first = this.unsupportedOpcodes[0];
            this.diagnostics.push(diag('warning', 'W2D_BINARY_PARTIAL', `${this.unsupportedOpcodes.length} unsupported opcode(s); first at byte ${first.offset}: ${first.message}`, this.sourcePath));
        }
        return {
            primitives: this.primitives,
            diagnostics: this.diagnostics,
            bounds: computeBounds(this.primitives),
            opcodes: this.opcodes,
            unsupportedOpcodes: this.unsupportedOpcodes
        };
    }
    parseSingleByteOpcode(opcode) {
        switch (opcode) {
            case 0x00:
                return true;
            case 0x03: { // set color RGBA
                const r = this.u8();
                const g = this.u8();
                const b = this.u8();
                const a = this.u8();
                this.state.stroke = rgba(r, g, b, a);
                if (this.state.fillOn)
                    this.state.fill = this.state.stroke;
                return true;
            }
            case 0x06: // set font
                this.readBinaryFont();
                return true;
            case 0x0c: { // draw line, 16-bit relative
                const pts = [this.point16Relative(), this.point16Relative()];
                this.polyline(pts);
                return true;
            }
            case 0x10: { // polyline/polygon, 16-bit relative pointset
                const pts = this.pointSet16Relative();
                this.pointSetPrimitive(pts);
                return true;
            }
            case 0x12: { // full circle, 16-bit relative center + uint16 radius
                const center = this.point16Relative();
                const radius = this.u16();
                this.ellipsePrimitive(center, radius, radius, 0, 0, 0);
                return true;
            }
            case 0x14: { // polytriangle, 16-bit relative pointset
                this.polytriangles(this.pointSet16Relative());
                return true;
            }
            case 0x17: // line weight, int32
                this.state.lineWidth = Math.max(0.2, Math.abs(this.i32()));
                return true;
            case 0x18: { // complex text
                const p = this.point32Relative();
                const text = cleanW2dText(this.readWhipString());
                this.text(p, text);
                this.skipComplexTextOptions();
                return true;
            }
            case 0x92: { // partial circle, 32-bit relative center + radius + short start/end angles
                const center = this.point32Relative();
                const radius = this.u32();
                const start = this.u16();
                const end = this.u16();
                this.ellipsePrimitive(center, radius, radius, start, end, 0, false);
                return true;
            }
            case 0xac: // layer by index
                this.readCount();
                return true;
            case 0xcc: // line pattern by index/enum; read count is tolerated for common Toolkit output.
                this.readCount();
                return true;
            case 0xe4: // blockref/macro-ish rendition compact records in classic files: read an index count when present.
                this.readCount();
                return true;
        }
        const ch = String.fromCharCode(opcode);
        switch (ch) {
            case 'B': // Bezier 32R, approximate by drawing control polygon when encountered.
                this.polyline(this.pointSet32Relative());
                return true;
            case 'C':
                this.state.stroke = aciColor(this.readAsciiInteger());
                if (this.state.fillOn)
                    this.state.fill = this.state.stroke;
                return true;
            case 'c':
                this.state.stroke = aciColor(this.u8());
                if (this.state.fillOn)
                    this.state.fill = this.state.stroke;
                return true;
            case 'E': {
                const center = this.readAsciiPoint();
                const axes = this.readAsciiPoint();
                this.ellipsePrimitive(center, axes.x, axes.y, 0, 0, 0);
                return true;
            }
            case 'e': {
                const center = this.point32Relative();
                const major = this.u32();
                const minor = this.u32();
                const start = this.u16();
                const end = this.u16();
                const tilt = this.u16();
                this.ellipsePrimitive(center, major, minor, start, end, tilt);
                return true;
            }
            case 'F':
                this.state.fillOn = true;
                this.state.fill = this.state.stroke;
                return true;
            case 'f':
                this.state.fillOn = false;
                this.state.fill = undefined;
                return true;
            case 'L': {
                const pts = [this.readAsciiPoint(), this.readAsciiPoint()];
                this.polyline(pts);
                return true;
            }
            case 'l': {
                const pts = [this.point32Relative(), this.point32Relative()];
                this.polyline(pts);
                return true;
            }
            case 'N': // object node, 32-bit form; object-node state is ignored for rendering.
                this.i32();
                return true;
            case 'n': // object node, 16-bit form
                this.u16();
                return true;
            case 'O': // origin, absolute point
                this.current = { x: this.i32(), y: this.i32() };
                return true;
            case 'P':
                this.pointSetPrimitive(this.pointSetAscii());
                return true;
            case 'p':
                this.pointSetPrimitive(this.pointSet32Relative());
                return true;
            case 'R': {
                const center = this.readAsciiPoint();
                const radius = this.readAsciiInteger();
                this.ellipsePrimitive(center, radius, radius, 0, 0, 0);
                return true;
            }
            case 'r': {
                const center = this.point32Relative();
                const radius = this.u32();
                this.ellipsePrimitive(center, radius, radius, 0, 0, 0);
                return true;
            }
            case 'T':
                this.polytriangles(this.pointSetAscii());
                return true;
            case 't':
                this.polytriangles(this.pointSet32Relative());
                return true;
            case 'V':
                this.state.visible = true;
                return true;
            case 'v':
                this.state.visible = false;
                return true;
            case 'x': {
                const p = this.point32Relative();
                const text = cleanW2dText(this.readWhipString());
                this.text(p, text);
                return true;
            }
        }
        return false;
    }
    parseExtendedAscii(start) {
        const { token, expr } = this.readBalancedExpression(start);
        switch (token) {
            case '(W2D': {
                const m = expr.match(/V(\d+)\.(\d+)/i);
                if (m)
                    this.decimalRevision = Number(m[1]) * 100 + Number(m[2]);
                break;
            }
            case '(Color': {
                const nums = numbers(expr);
                if (nums.length >= 3)
                    this.state.stroke = rgb(nums[0], nums[1], nums[2]);
                break;
            }
            case '(LineWeight': {
                const nums = numbers(expr);
                if (nums.length >= 1)
                    this.state.lineWidth = Math.max(0.2, Math.abs(nums[0]));
                break;
            }
            case '(Font': {
                const height = expr.match(/\(Height\s+(-?\d+)/i)?.[1];
                const rotation = expr.match(/\(Rotation\s+(-?\d+)/i)?.[1];
                const name = expr.match(/\(Name\s+(['"])(.*?)\1/i)?.[2];
                if (height)
                    this.state.fontHeight = Math.max(1, Math.abs(Number(height)));
                if (rotation)
                    this.state.fontRotation = Number(rotation) || 0;
                if (name)
                    this.state.fontName = name;
                break;
            }
            case '(EndOfDWF':
                this.pos = this.bytes.length;
                break;
            default:
                // Metadata, viewport, line style, font extension, fill pattern, etc. are not needed to emit base geometry.
                break;
        }
    }
    parseExtendedBinary(start) {
        if (this.remaining() < 6)
            return false;
        const size = this.u32();
        const opcode = this.u16();
        if (opcode === 0x0011 || opcode === 0x0010 || opcode === 0x0123) {
            this.unsupportedOpcodes.push({ offset: start, opcode: `{${opcode.toString(16)}}`, message: 'Embedded compressed WHIP block detected. This build renders uncompressed binary W2D streams and manifest markup XML; compressed nested blocks are skipped.' });
            // In many markup W2D resources the compressed block length is zero and the rest of the resource is the payload.
            this.pos = size > 0 && this.pos + size <= this.bytes.length ? this.pos + size : this.bytes.length;
            return true;
        }
        // Most extended binary objects carry an offset/length-like field. If it is non-zero and plausible, skip it.
        if (size > 0 && this.pos + size <= this.bytes.length) {
            this.pos += size;
            return true;
        }
        this.unsupportedOpcodes.push({ offset: start, opcode: `{${opcode.toString(16)}}`, message: 'Unsupported extended binary WHIP object with unknown payload size.' });
        return false;
    }
    readBinaryFont() {
        const fields = this.u16();
        if (fields & FONT_NAME_BIT)
            this.state.fontName = this.readWhipString() || this.state.fontName;
        if (fields & FONT_CHARSET_BIT)
            this.u8();
        if (fields & FONT_PITCH_BIT)
            this.u8();
        if (fields & FONT_FAMILY_BIT)
            this.u8();
        if (fields & FONT_STYLE_BIT)
            this.u8();
        if (fields & FONT_HEIGHT_BIT)
            this.state.fontHeight = Math.max(1, Math.abs(this.i32()));
        if (fields & FONT_ROTATION_BIT)
            this.state.fontRotation = this.u16();
        if (fields & FONT_WIDTH_SCALE_BIT)
            this.u16();
        if (fields & FONT_SPACING_BIT)
            this.u16();
        if (fields & FONT_OBLIQUE_BIT)
            this.u16();
        if (fields & FONT_FLAGS_BIT)
            this.i32();
    }
    skipComplexTextOptions() {
        this.skipScoringOption();
        this.skipScoringOption();
        for (let i = 0; i < 4; i++) {
            this.i32();
            this.i32();
        }
        // Reserved/CharPos option appears in package-format DWF 6+. Tolerate EOF for older streams.
        if (this.decimalRevision >= 600 && this.pos < this.bytes.length) {
            const count = Math.max(0, this.readCount() - 1);
            for (let i = 0; i < count; i++)
                this.readCount();
        }
    }
    skipScoringOption() {
        const count = Math.max(0, this.readCount() - 1);
        for (let i = 0; i < count; i++)
            this.readCount();
    }
    pointSetPrimitive(pts) {
        if (this.state.fillOn)
            this.polygon(pts, this.state.fill ?? this.state.stroke, this.state.stroke);
        else
            this.polyline(pts);
    }
    polytriangles(pts) {
        if (!this.state.visible || pts.length < 3)
            return;
        for (let i = 0; i + 2 < pts.length; i++) {
            this.polygon([pts[i], pts[i + 1], pts[i + 2]], this.state.stroke, undefined);
        }
    }
    polyline(pts) {
        if (!this.state.visible || pts.length < 2)
            return;
        this.primitives.push({ type: 'polyline', points: flattenPoints(pts), stroke: this.state.stroke, lineWidth: this.state.lineWidth });
    }
    polygon(pts, fill, stroke) {
        if (!this.state.visible || pts.length < 3)
            return;
        this.primitives.push({ type: 'polygon', points: flattenPoints(pts), fill, stroke, lineWidth: this.state.lineWidth });
    }
    ellipsePrimitive(center, major, minor, start, end, tilt, filled = this.state.fillOn) {
        const pts = ellipsePoints(center, major, minor, start, end, tilt);
        if (filled)
            this.polygon(pts, this.state.fill ?? this.state.stroke, this.state.stroke);
        else
            this.polyline(pts);
    }
    text(p, text) {
        if (!this.state.visible || !text.trim())
            return;
        this.primitives.push({
            type: 'text',
            x: p.x,
            y: p.y,
            text,
            size: Math.max(10, Math.abs(this.state.fontHeight)),
            fill: this.state.stroke
        });
    }
    pointSet32Relative() {
        const count = this.readCount();
        const pts = [];
        for (let i = 0; i < count; i++)
            pts.push(this.point32Relative());
        return pts;
    }
    pointSet16Relative() {
        const count = this.readCount();
        const pts = [];
        for (let i = 0; i < count; i++)
            pts.push(this.point16Relative());
        return pts;
    }
    pointSetAscii() {
        const count = this.readAsciiInteger();
        const pts = [];
        for (let i = 0; i < count; i++)
            pts.push(this.readAsciiPoint());
        return pts;
    }
    point32Relative() {
        const dx = this.i32();
        const dy = this.i32();
        this.current = { x: this.current.x + dx, y: this.current.y + dy };
        return { ...this.current };
    }
    point16Relative() {
        const dx = this.i16();
        const dy = this.i16();
        this.current = { x: this.current.x + dx, y: this.current.y + dy };
        return { ...this.current };
    }
    readAsciiPoint() {
        const x = this.readAsciiInteger();
        if (this.peek() === 0x2c)
            this.pos++;
        const y = this.readAsciiInteger();
        return { x, y };
    }
    readAsciiInteger() {
        this.eatWhitespace();
        const start = this.pos;
        if (this.peek() === 0x2b || this.peek() === 0x2d)
            this.pos++;
        while (this.pos < this.bytes.length && isDigit(this.bytes[this.pos]))
            this.pos++;
        const raw = ascii(this.bytes.subarray(start, this.pos));
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) ? n : 0;
    }
    readWhipString() {
        this.eatWhitespace();
        const lead = this.peek();
        if (lead === 0x7b) { // binary UTF-16 string: { int32 length, uint16 data..., }
            this.pos++;
            const length = this.i32();
            const byteLength = Math.max(0, length * 2);
            if (this.pos + byteLength > this.bytes.length)
                throw new Error('Truncated binary WHIP string.');
            const s = new TextDecoder('utf-16le').decode(this.bytes.subarray(this.pos, this.pos + byteLength));
            this.pos += byteLength;
            if (this.peek() === 0x7d)
                this.pos++;
            return s;
        }
        if (lead === 0x22 || lead === 0x27) {
            const quote = this.u8();
            const out = [];
            let escaped = false;
            while (this.pos < this.bytes.length) {
                const c = this.u8();
                if (escaped) {
                    out.push(c);
                    escaped = false;
                }
                else if (c === 0x5c) {
                    out.push(c);
                    escaped = true;
                }
                else if (c === quote) {
                    break;
                }
                else {
                    out.push(c);
                }
            }
            return ascii(new Uint8Array(out));
        }
        const start = this.pos;
        while (this.pos < this.bytes.length) {
            const c = this.bytes[this.pos];
            if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x29)
                break;
            this.pos++;
        }
        return ascii(this.bytes.subarray(start, this.pos));
    }
    readBalancedExpression(start) {
        this.pos = start;
        let depth = 0;
        let quote = 0;
        let escaped = false;
        while (this.pos < this.bytes.length) {
            const c = this.u8();
            if (quote) {
                if (escaped)
                    escaped = false;
                else if (c === 0x5c)
                    escaped = true;
                else if (c === quote)
                    quote = 0;
            }
            else if (c === 0x22 || c === 0x27) {
                quote = c;
            }
            else if (c === 0x28) {
                depth++;
            }
            else if (c === 0x29) {
                depth--;
                if (depth <= 0)
                    break;
            }
        }
        const raw = ascii(this.bytes.subarray(start, this.pos));
        const token = raw.match(/^\([^\s()]+/)?.[0] ?? '(';
        return { token, expr: raw };
    }
    readCount() {
        const c = this.u8();
        return c !== 0 ? c : 256 + this.u16();
    }
    eatWhitespace() {
        while (this.pos < this.bytes.length) {
            const b = this.bytes[this.pos];
            if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d)
                this.pos++;
            else
                break;
        }
    }
    remaining() { return this.bytes.length - this.pos; }
    peek() { return this.pos < this.bytes.length ? this.bytes[this.pos] : undefined; }
    u8() { if (this.remaining() < 1)
        throw new Error('Unexpected EOF'); return this.view.getUint8(this.pos++); }
    i16() { if (this.remaining() < 2)
        throw new Error('Unexpected EOF'); const n = this.view.getInt16(this.pos, true); this.pos += 2; return n; }
    u16() { if (this.remaining() < 2)
        throw new Error('Unexpected EOF'); const n = this.view.getUint16(this.pos, true); this.pos += 2; return n; }
    i32() { if (this.remaining() < 4)
        throw new Error('Unexpected EOF'); const n = this.view.getInt32(this.pos, true); this.pos += 4; return n; }
    u32() { if (this.remaining() < 4)
        throw new Error('Unexpected EOF'); const n = this.view.getUint32(this.pos, true); this.pos += 4; return n; }
}
function flattenPoints(pts) {
    const out = [];
    for (const p of pts)
        out.push(p.x, p.y);
    return out;
}
function ellipsePoints(center, major, minor, start, end, tilt) {
    let s = start;
    let e = end;
    if (s === 0 && e === 0)
        e = 0x10000;
    else if (e <= s)
        e += 0x10000;
    const sweep = e - s;
    const segs = Math.max(16, Math.min(144, Math.ceil(Math.abs(sweep) / 0x10000 * 96)));
    const tiltRad = tilt * Math.PI * 2 / 0x10000;
    const ct = Math.cos(tiltRad), st = Math.sin(tiltRad);
    const pts = [];
    for (let i = 0; i <= segs; i++) {
        const a = (s + sweep * i / segs) * Math.PI * 2 / 0x10000;
        const x = Math.cos(a) * major;
        const y = Math.sin(a) * minor;
        pts.push({ x: center.x + x * ct - y * st, y: center.y + x * st + y * ct });
    }
    return pts;
}
function cleanW2dText(text) {
    return text
        .replace(/\\P/gi, '\n')
        .replace(/\\L|\\l/g, '')
        .replace(/\\O|\\o/g, '')
        .replace(/\\H[-+]?\d*\.?\d+x;/gi, '')
        .replace(/\\S([^;]+);/gi, '$1')
        .replace(/\\[A-Za-z][^;]*;/g, '')
        .replace(/\\~/g, ' ')
        .replace(/\\\\/g, '\\')
        .trim();
}
function computeBounds(primitives) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const p of primitives) {
        if ('points' in p) {
            for (let i = 0; i + 1 < p.points.length; i += 2)
                add(p.points[i], p.points[i + 1]);
        }
        else if (p.type === 'rect') {
            add(p.x, p.y);
            add(p.x + p.width, p.y + p.height);
        }
        else if (p.type === 'text') {
            const size = p.size ?? 12;
            add(p.x, p.y);
            add(p.x, p.y + size);
        }
        else if (p.type === 'path') {
            for (const c of p.commands) {
                if ('x' in c && 'y' in c)
                    add(c.x, c.y);
                if ('x1' in c && 'y1' in c)
                    add(c.x1, c.y1);
                if ('x2' in c && 'y2' in c)
                    add(c.x2, c.y2);
            }
        }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}
function isDigit(b) { return b >= 0x30 && b <= 0x39; }
function ascii(bytes) { return Array.from(bytes, b => String.fromCharCode(b)).join(''); }
function rgb(r, g, b) { return `rgb(${clamp8(r)}, ${clamp8(g)}, ${clamp8(b)})`; }
function rgba(r, g, b, a) { return `rgba(${clamp8(r)}, ${clamp8(g)}, ${clamp8(b)}, ${Math.max(0, Math.min(1, a / 255))})`; }
function clamp8(n) { return Math.max(0, Math.min(255, Math.round(n))); }
function numbers(s) { return (s.match(/[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite); }
function aciColor(index) {
    const table = ['#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#000000', '#808080', '#c0c0c0'];
    return table[index] ?? '#000000';
}
