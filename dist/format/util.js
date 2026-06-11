export const textDecoder = new TextDecoder('utf-8');
export const asciiDecoder = new TextDecoder('ascii');
export function decodeUtf8(bytes) {
    return textDecoder.decode(bytes);
}
export function decodeUtf16Le(bytes) {
    return new TextDecoder('utf-16le').decode(bytes);
}
export function normalizePath(path) {
    const parts = [];
    const normalized = path.replace(/\\/g, '/');
    for (const part of normalized.split('/')) {
        if (!part || part === '.')
            continue;
        if (part === '..')
            parts.pop();
        else
            parts.push(part);
    }
    return parts.join('/');
}
export function dirname(path) {
    const n = normalizePath(path);
    const i = n.lastIndexOf('/');
    return i < 0 ? '' : n.slice(0, i);
}
export function resolvePart(basePath, target) {
    if (!target)
        return normalizePath(basePath);
    if (target.startsWith('/'))
        return normalizePath(target.slice(1));
    const baseDir = dirname(basePath);
    return normalizePath((baseDir ? baseDir + '/' : '') + target);
}
export function stripNamespace(name) {
    const i = name.indexOf(':');
    return i >= 0 ? name.slice(i + 1) : name;
}
export function localName(el) {
    return stripNamespace(el.localName || el.nodeName);
}
export function getAttr(el, name) {
    return el.getAttribute(name) ?? el.getAttributeNS(null, name) ?? undefined;
}
export function childElements(el) {
    return Array.from(el.childNodes).filter((n) => n.nodeType === 1);
}
export function parseXml(xml, source = 'document.xml') {
    if (typeof DOMParser !== 'undefined') {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const err = doc.getElementsByTagName('parsererror')[0];
        if (err)
            throw new Error(`XML parse error in ${source}: ${err.textContent?.slice(0, 180) ?? 'unknown error'}`);
        return doc;
    }
    // Node.js and some worker-like runtimes do not expose DOMParser. Keep the core
    // package dependency-free by falling back to a small XML tree parser that implements
    // only the DOM surface used by the DWF/DWFx readers: getElementsByTagName,
    // getAttribute, attributes, localName, nodeName, nodeType, childNodes, and textContent.
    try {
        return parseXmlFallback(xml);
    }
    catch (err) {
        throw new Error(`XML parse error in ${source}: ${String(err)}`);
    }
}
class SimpleXmlElement {
    constructor(name, attrs) {
        this.nodeType = 1;
        this.childNodes = [];
        this.nodeName = name;
        this.localName = stripNamespace(name);
        this.attributes = attrs;
    }
    get textContent() {
        return this.childNodes.map(n => n.textContent ?? '').join('');
    }
    get children() {
        return this.childNodes.filter((n) => n instanceof SimpleXmlElement);
    }
    getAttribute(name) {
        return this.attributes.find(a => a.name === name || a.nodeName === name)?.value ?? null;
    }
    getAttributeNS(_ns, name) {
        return this.attributes.find(a => a.localName === name)?.value ?? null;
    }
    getElementsByTagName(name) {
        const out = [];
        const visit = (el) => {
            if (name === '*' || el.nodeName === name || el.localName === name)
                out.push(el);
            for (const child of el.childNodes)
                if (child instanceof SimpleXmlElement)
                    visit(child);
        };
        for (const child of this.childNodes)
            if (child instanceof SimpleXmlElement)
                visit(child);
        return out;
    }
}
class SimpleXmlText {
    constructor(textContent) {
        this.textContent = textContent;
        this.nodeType = 3;
    }
}
class SimpleXmlDocument {
    constructor() {
        this.nodeType = 9;
        this.childNodes = [];
    }
    get textContent() {
        return this.childNodes.map(n => n.textContent ?? '').join('');
    }
    get children() {
        return this.childNodes.filter((n) => n instanceof SimpleXmlElement);
    }
    get documentElement() {
        return this.children[0];
    }
    getElementsByTagName(name) {
        const out = [];
        const visit = (el) => {
            if (name === '*' || el.nodeName === name || el.localName === name)
                out.push(el);
            for (const child of el.childNodes)
                if (child instanceof SimpleXmlElement)
                    visit(child);
        };
        for (const child of this.childNodes)
            if (child instanceof SimpleXmlElement)
                visit(child);
        return out;
    }
}
function parseXmlFallback(xml) {
    const doc = new SimpleXmlDocument();
    const stack = [doc];
    let pos = 0;
    while (pos < xml.length) {
        const lt = xml.indexOf('<', pos);
        if (lt < 0) {
            appendText(stack[stack.length - 1], xml.slice(pos));
            break;
        }
        if (lt > pos)
            appendText(stack[stack.length - 1], xml.slice(pos, lt));
        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt + 4);
            if (end < 0)
                throw new Error('Unclosed XML comment.');
            pos = end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt + 9);
            if (end < 0)
                throw new Error('Unclosed XML CDATA section.');
            appendText(stack[stack.length - 1], xml.slice(lt + 9, end));
            pos = end + 3;
            continue;
        }
        if (xml.startsWith('<?', lt)) {
            const end = xml.indexOf('?>', lt + 2);
            if (end < 0)
                throw new Error('Unclosed XML processing instruction.');
            pos = end + 2;
            continue;
        }
        if (xml.startsWith('<!', lt)) {
            const end = xml.indexOf('>', lt + 2);
            if (end < 0)
                throw new Error('Unclosed XML declaration.');
            pos = end + 1;
            continue;
        }
        const gt = findTagEnd(xml, lt + 1);
        if (gt < 0)
            throw new Error('Unclosed XML tag.');
        let tag = xml.slice(lt + 1, gt).trim();
        pos = gt + 1;
        if (!tag)
            continue;
        if (tag[0] === '/') {
            const name = tag.slice(1).trim().split(/\s+/)[0] ?? '';
            let popped = stack.pop();
            while (popped && popped instanceof SimpleXmlElement && popped.nodeName !== name && popped.localName !== stripNamespace(name) && stack.length > 0) {
                popped = stack.pop();
            }
            if (stack.length === 0)
                stack.push(doc);
            continue;
        }
        const selfClosing = tag.endsWith('/');
        if (selfClosing)
            tag = tag.slice(0, -1).trim();
        const space = tag.search(/\s/);
        const name = space < 0 ? tag : tag.slice(0, space);
        const attrSource = space < 0 ? '' : tag.slice(space + 1);
        const el = new SimpleXmlElement(name, parseAttrs(attrSource));
        const parent = stack[stack.length - 1];
        el.parentNode = parent;
        parent.childNodes.push(el);
        if (!selfClosing)
            stack.push(el);
    }
    return doc;
}
function appendText(parent, raw) {
    if (!raw)
        return;
    const text = decodeXmlEntities(raw);
    if (text.trim().length === 0)
        return;
    parent.childNodes.push(new SimpleXmlText(text));
}
function findTagEnd(xml, start) {
    let quote = '';
    for (let i = start; i < xml.length; i++) {
        const c = xml[i];
        if (quote) {
            if (c === quote)
                quote = '';
        }
        else if (c === '"' || c === "'") {
            quote = c;
        }
        else if (c === '>') {
            return i;
        }
    }
    return -1;
}
function parseAttrs(input) {
    const attrs = [];
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(input))) {
        const name = m[1];
        const value = decodeXmlEntities(m[2] ?? m[3] ?? '');
        attrs.push({ name, nodeName: name, localName: stripNamespace(name), value });
    }
    return attrs;
}
function decodeXmlEntities(input) {
    return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, ent) => {
        if (ent === 'amp')
            return '&';
        if (ent === 'lt')
            return '<';
        if (ent === 'gt')
            return '>';
        if (ent === 'quot')
            return '"';
        if (ent === 'apos')
            return "'";
        if (ent.startsWith('#x'))
            return String.fromCodePoint(Number.parseInt(ent.slice(2), 16));
        if (ent.startsWith('#'))
            return String.fromCodePoint(Number.parseInt(ent.slice(1), 10));
        return _m;
    });
}
export function bytesLookTextual(bytes, sampleLength = 2048) {
    const n = Math.min(sampleLength, bytes.length);
    if (n === 0)
        return true;
    let printable = 0;
    let control = 0;
    for (let i = 0; i < n; i++) {
        const b = bytes[i];
        if (b === 0)
            return false;
        if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 160)
            printable++;
        else
            control++;
    }
    return printable / n > 0.85 && control < 20;
}
export function extname(path) {
    const clean = path.split(/[?#]/)[0] ?? path;
    const slash = clean.lastIndexOf('/');
    const dot = clean.lastIndexOf('.');
    return dot > slash ? clean.slice(dot + 1).toLowerCase() : '';
}
export function mimeFromPath(path) {
    switch (extname(path)) {
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'bmp': return 'image/bmp';
        case 'tif':
        case 'tiff': return 'image/tiff';
        case 'w2d': return 'application/x-dwf-w2d';
        case 'hsf': return 'model/vnd.hsf';
        case 'fpage': return 'application/vnd.ms-package.xps-fixeddocumentsequence+xml';
        case 'fdseq': return 'application/vnd.ms-package.xps-fixeddocumentsequence+xml';
        case 'fdoc': return 'application/vnd.ms-package.xps-fixeddocument+xml';
        default: return undefined;
    }
}
export async function blobToImage(bytes, type) {
    const blob = new Blob([bytes], { type });
    if ('createImageBitmap' in globalThis) {
        return await createImageBitmap(blob);
    }
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to decode image')); };
        img.src = url;
    });
}
export function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}
export function parseNumberList(input) {
    const matches = input.match(/[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
    return matches ? matches.map(Number).filter(Number.isFinite) : [];
}
