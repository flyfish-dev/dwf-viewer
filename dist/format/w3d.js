import { BrowserInflateProvider } from './inflate.js';
import { diag } from './types.js';
const TKSH_COMPRESSED_POINTS = 0x01;
const TKSH_TRISTRIPS = 0x04;
const TKSH_FIRSTPASS = 0x10;
const TKSH_BOUNDING_ONLY = 0x20;
const TKSH_CONNECTIVITY_COMPRESSION = 0x40;
const TKSH_EXPANDED = 0x80;
const TKSH2_COLLECTION = 0x0001;
const TKSH2_NULL = 0x0002;
const TKSH2_HAS_NEGATIVE_FACES = 0x0004;
const TKSH2_GLOBAL_QUANTIZATION = 0x0008;
const CS_TRIVIAL = 1;
const CS_NONE = 4;
const CS_EDGEBREAKER = 5;
const MTABLE_HAS_LENGTHS = 0x01;
const MTABLE_HAS_M2STACKOFFSETS = 0x02;
const MTABLE_HAS_M2GATEOFFSETS = 0x04;
const MTABLE_HAS_DUMMIES = 0x08;
const MTABLE_HAS_PATCHES = 0x10;
const MTABLE_HAS_BOUNDING = 0x20;
const MTABLE_HAS_QUANTIZATION = 0x40;
const MTABLE_HAS_QUANTIZATION_NORMALS = 0x80;
const CASE_C = 0;
const CASE_L = 1;
const CASE_E = 2;
const CASE_R = 3;
const CASE_S = 4;
const CASE_M = 5;
const CASE_M2 = 6;
const GARBAGE_EDGE = -2139062144;
const DUMMY_VERTEX = -2147483645;
const POINTMAP_DUMMY = -2139062145;
const POINTMAP_ALIAS = -2139062146;
export async function parseW3dModel(bytes, options = {}) {
    const diagnostics = [];
    const stream = await inflateW3dStream(bytes, diagnostics, options.sourcePath);
    const meshes = [];
    const seen = new Set();
    const maxMeshes = options.maxMeshes ?? 10000;
    const maxTriangles = options.maxTriangles ?? 10000000;
    let unsupportedEdgebreaker = 0;
    let falseShellCandidates = 0;
    let triangles = 0;
    for (let pos = 0; pos < stream.length && meshes.length < maxMeshes && triangles < maxTriangles; pos++) {
        if (stream[pos] !== 0x53)
            continue; // TKE_Shell ('S')
        try {
            const parsed = parseShellCandidate(stream, pos, meshes.length + 1);
            if (!parsed)
                continue;
            const key = `${parsed.sourceStart}:${parsed.sourceEnd}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            meshes.push(parsed);
            triangles += parsed.triangleCount;
            pos = Math.max(pos, parsed.sourceEnd - 1);
        }
        catch (err) {
            const msg = String(err);
            if (/edgebreaker/i.test(msg))
                unsupportedEdgebreaker++;
            else
                falseShellCandidates++;
        }
    }
    if (unsupportedEdgebreaker > 0) {
        diagnostics.push(diag('warning', 'W3D_EDGEBREAKER_PARTIAL', `${unsupportedEdgebreaker} connectivity-compressed shell candidate(s) were skipped.`, options.sourcePath));
    }
    void falseShellCandidates; // filtered byte-pattern candidates are expected in mixed HSF streams; keep diagnostics noise-free.
    if (meshes.length === 0) {
        diagnostics.push(diag('error', 'W3D_NO_MESHES', 'No renderable W3D shell meshes were decoded.', options.sourcePath));
    }
    const bounds = computeModelBounds(meshes);
    return {
        kind: 'w3d-model',
        title: options.title ?? '3D Model',
        meshes,
        bounds,
        diagnostics,
        sourcePath: options.sourcePath,
        stats: {
            meshCount: meshes.length,
            vertexCount: meshes.reduce((s, m) => s + m.vertexCount, 0),
            triangleCount: meshes.reduce((s, m) => s + m.triangleCount, 0),
            decodedBytes: stream.byteLength,
            edgeCount: meshes.reduce((s, m) => s + Math.floor((m.edgeIndices?.length ?? 0) / 2), 0),
            materialCount: 0,
            textureCount: 0,
            pmiCount: 0,
            nodeCount: 0
        }
    };
}
async function inflateW3dStream(bytes, diagnostics, sourcePath) {
    // HSF/W3D files often contain an uncompressed banner followed by
    // TKE_Start_Compression ('Z') and a zlib-wrapped deflate stream.
    //
    // Important browser detail: Chromium's DecompressionStream('deflate') can be
    // stricter than Node when the zlib stream is followed by HSF padding bytes.
    // The Robot Arm eModel file has one trailing NUL byte after the zlib stream.
    // Node accepts it; browsers can reject it, which was the root cause of the
    // "W3D exists but no renderable shell geometry was decoded" unsupported page.
    //
    // To be deterministic in production, try a browser-safe raw-deflate payload
    // first: strip the 2-byte zlib header, trim trailing NUL padding, and remove
    // the 4-byte Adler32 trailer.  Then fall back to the exact zlib candidate and
    // finally to the historical broad candidate.
    const inflater = new BrowserInflateProvider();
    for (let p = 0; p + 6 < bytes.length; p++) {
        if (bytes[p] !== 0x78)
            continue;
        const b = bytes[p + 1];
        if (b !== 0x01 && b !== 0x5e && b !== 0x9c && b !== 0xda)
            continue;
        const zlibCandidate = bytes.subarray(p);
        const trimmed = trimTrailingNulPadding(zlibCandidate);
        const attempts = [];
        if (trimmed.length > 6)
            attempts.push({ label: 'raw-deflate-body', data: trimmed.subarray(2, trimmed.length - 4) });
        if (zlibCandidate.length > 2)
            attempts.push({ label: 'raw-deflate-body-with-trailer', data: zlibCandidate.subarray(2) });
        attempts.push({ label: 'zlib-trimmed', data: trimmed });
        if (trimmed.length !== zlibCandidate.length)
            attempts.push({ label: 'zlib-with-padding', data: zlibCandidate });
        for (const attempt of attempts) {
            try {
                const inflated = await inflater.inflateRaw(attempt.data);
                void sourcePath;
                return inflated;
            }
            catch {
                // Continue with the next interpretation.  The same byte sequence can
                // also appear in comments or binary attribute payloads.
            }
        }
    }
    void sourcePath;
    return bytes;
}
function trimTrailingNulPadding(data) {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0)
        end--;
    return end === data.length ? data : data.subarray(0, end);
}
function parseShellCandidate(bytes, start, ordinal) {
    const r = reader(bytes, start + 1);
    const subop = getU8(r);
    let subop2 = 0;
    if ((subop & TKSH_EXPANDED) !== 0)
        subop2 = getU16(r);
    if ((subop & TKSH_BOUNDING_ONLY) !== 0)
        return undefined;
    if ((subop & TKSH_FIRSTPASS) === 0)
        getI32(r); // shell index for additional LOD/pass
    getU8(r); // lod level
    if ((subop2 & (TKSH2_COLLECTION | TKSH2_NULL)) !== 0)
        return undefined;
    const compressedShell = (subop & (TKSH_COMPRESSED_POINTS | TKSH_CONNECTIVITY_COMPRESSION)) !== 0;
    const scheme = compressedShell ? getU8(r) : CS_NONE;
    let positions;
    let indices;
    let decodeKind;
    if (scheme === CS_EDGEBREAKER) {
        const len = getI32(r);
        if (len <= 0 || r.pos + len > bytes.length || len > 100000000)
            throw new Error('Bad edgebreaker block length.');
        const ebStart = r.pos;
        const eb = bytes.subarray(r.pos, r.pos + len);
        r.pos += len;
        const ebDecoded = decodeEdgebreaker(eb);
        // Since HSF 7+, TK_Shell may store edgebreaker connectivity and then write full-resolution
        // vertex positions immediately after the edgebreaker block.  Autodesk Inventor's eModel DWFx
        // files commonly use this form; it gives exact coordinates without having to reconstruct them
        // from parallelogram-predicted quantized residuals.
        if ((subop & TKSH_COMPRESSED_POINTS) === 0) {
            const pointFloats = ebDecoded.pointCount * 3;
            if (r.pos + pointFloats * 4 > bytes.length)
                throw new Error('Edgebreaker shell has no following full-resolution vertex array.');
            positions = readFloat32Array(bytes, r.pos, pointFloats);
            r.pos += pointFloats * 4;
        }
        else {
            throw new Error('edgebreaker quantized-point reconstruction is not enabled for this shell.');
        }
        indices = indexArrayFor(ebDecoded.faces, ebDecoded.pointCount);
        decodeKind = `edgebreaker-v${eb[0] ?? 0}`;
        if (indices.length < 3)
            throw new Error('Empty edgebreaker face list.');
    }
    else if (scheme === CS_NONE) {
        const pointCount = getI32(r);
        if (pointCount <= 0 || pointCount > 10000000)
            throw new Error('Bad uncompressed shell point count.');
        positions = readFloat32Array(bytes, r.pos, pointCount * 3);
        r.pos += pointCount * 3 * 4;
        const faceResult = readCompressedFaceList(r, pointCount, (subop & TKSH_TRISTRIPS) !== 0, false);
        indices = indexArrayFor(faceResult.indices, pointCount);
        decodeKind = 'uncompressed';
    }
    else if (scheme === CS_TRIVIAL) {
        const pointCount = getI32(r);
        if (pointCount <= 0 || pointCount > 10000000)
            throw new Error('Bad compressed shell point count.');
        const bounds = (subop2 & TKSH2_GLOBAL_QUANTIZATION) === 0 ? readFloatTuple(r, 6) : [0, 0, 0, 1, 1, 1];
        const bitsPerSample = getU8(r);
        const dataLen = getI32(r);
        if (dataLen <= 0 || r.pos + dataLen > bytes.length)
            throw new Error('Bad compressed shell point payload length.');
        positions = decodeQuantizedPoints(bytes.subarray(r.pos, r.pos + dataLen), pointCount, bitsPerSample, bounds);
        r.pos += dataLen;
        const faceResult = readCompressedFaceList(r, pointCount, (subop & TKSH_TRISTRIPS) !== 0, (subop2 & TKSH2_HAS_NEGATIVE_FACES) !== 0);
        indices = indexArrayFor(faceResult.indices, pointCount);
        decodeKind = `quantized-${bitsPerSample}`;
    }
    else {
        throw new Error(`Unsupported W3D shell compression scheme ${scheme}.`);
    }
    if (indices.length < 3 || positions.length < 9)
        return undefined;
    const normals = computeVertexNormals(positions, indices);
    const edgeIndices = computeFeatureEdges(positions, indices);
    const bounds = boundsFromPositions(positions);
    return {
        id: `w3d-mesh-${ordinal}`,
        name: `Mesh ${ordinal}`,
        positions,
        normals,
        indices,
        edgeIndices,
        vertexCount: Math.floor(positions.length / 3),
        triangleCount: Math.floor(indices.length / 3),
        bounds,
        color: colorForOrdinal(ordinal),
        sourceStart: start,
        sourceEnd: r.pos,
        decodeKind
    };
}
function decodeEdgebreaker(block) {
    if (block.byteLength < 24)
        throw new Error('Edgebreaker block is too short.');
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const scheme = block[0];
    const mtableScheme = block[1];
    const pointsScheme = block[2];
    const normalsScheme = block[3];
    const opsLen = view.getInt32(4, true);
    const mtableLen = view.getInt32(8, true);
    const pointsLen = view.getInt32(12, true);
    const pointCount = view.getInt32(16, true);
    const normalsLen = view.getInt32(20, true);
    if (scheme < 0 || scheme > 2 || mtableScheme !== 0 || pointsScheme < 0 || pointsScheme > 3 || normalsScheme < 0 || normalsScheme > 3) {
        throw new Error('Unsupported edgebreaker header.');
    }
    if (opsLen <= 0 || mtableLen < 0 || pointCount <= 0)
        throw new Error('Invalid edgebreaker sizes.');
    let p = scheme >= 1 ? 24 : 20;
    const ops = block.subarray(p, p + opsLen);
    p += opsLen + toNext4(p + opsLen);
    if (p + mtableLen > block.length)
        throw new Error('Invalid edgebreaker MTable offset.');
    const mtable = unpackMTable(block.subarray(p, p + mtableLen));
    p += mtableLen + toNext4(p + mtableLen);
    const processed = processEdgebreakerOpcodes(ops, mtable);
    const patched = patchEdgebreakerFaces(processed.opcodePointCount, mtable, processed.faces);
    const faces = [];
    for (const f of patched)
        faces.push(f[1], f[2], f[3]);
    const maxIndex = faces.reduce((m, v) => Math.max(m, v), -1);
    const minIndex = faces.reduce((m, v) => Math.min(m, v), pointCount);
    if (minIndex < 0 || maxIndex >= pointCount)
        throw new Error(`Edgebreaker face index range ${minIndex}..${maxIndex} is outside point count ${pointCount}.`);
    const diagnostics = [];
    void pointsLen;
    void normalsLen;
    return { pointCount, faces, triangleCount: faces.length / 3, diagnostics };
}
function unpackMTable(buf) {
    const r = reader(buf, 0);
    const flags = getI32(r);
    const mlengthsUsed = (flags & MTABLE_HAS_LENGTHS) !== 0 ? getI32(r) : 0;
    const m2stackUsed = (flags & MTABLE_HAS_M2STACKOFFSETS) !== 0 ? getI32(r) : 0;
    const m2gateUsed = (flags & MTABLE_HAS_M2GATEOFFSETS) !== 0 ? m2stackUsed : 0;
    const dummiesUsed = (flags & MTABLE_HAS_DUMMIES) !== 0 ? getI32(r) : 0;
    const patchesUsed = (flags & MTABLE_HAS_PATCHES) !== 0 ? getI32(r) : 0;
    const mlengths = readIntArray(r, mlengthsUsed);
    const m2stackoffsets = readIntArray(r, m2stackUsed);
    const m2gateoffsets = readIntArray(r, m2gateUsed);
    const dummies = [];
    let prev = 0;
    for (let i = 0; i < dummiesUsed; i++) {
        prev += getI32(r);
        dummies.push(prev);
    }
    const patches = [];
    const patchMap = new Map();
    prev = 0;
    for (let i = 0; i < patchesUsed; i += 2) {
        const oldVertex = getI32(r) + prev;
        prev = oldVertex;
        const newVertex = getI32(r);
        patches.push(oldVertex, newVertex);
        patchMap.set(oldVertex, newVertex);
    }
    const bounding = (flags & MTABLE_HAS_BOUNDING) !== 0 ? readFloatTuple(r, 6) : undefined;
    const quantization = (flags & MTABLE_HAS_QUANTIZATION) !== 0 ? [getI32(r), getI32(r), getI32(r)] : [11, 11, 11];
    const normalQuantization = (flags & MTABLE_HAS_QUANTIZATION_NORMALS) !== 0 ? [getI32(r), getI32(r), getI32(r)] : [11, 11, 11];
    return { flags, mlengths, m2stackoffsets, m2gateoffsets, dummies, patches, patchMap, bounding, quantization, normalQuantization };
}
function processEdgebreakerOpcodes(opsBytes, mtable) {
    const ops = Array.from(opsBytes);
    const faces = [];
    let v = 0;
    let i = 0;
    while (i < ops.length) {
        const { ecount, offsets } = preprocessEdgebreakerOps(ops, i, mtable);
        if (ecount <= 0)
            throw new Error(`Invalid edgebreaker boundary loop length ${ecount}.`);
        const N = [];
        const P = [];
        const start = [];
        const twin = [];
        const edges = [];
        for (let j = 0; j < ecount; j++) {
            P[j] = j - 1;
            N[j] = j + 1;
            start[j] = v++;
            twin[j] = GARBAGE_EDGE;
        }
        P[0] = ecount - 1;
        N[ecount - 1] = 0;
        let gi = 0;
        let scount = 0;
        let hashUsed = ecount;
        const gateStack = [];
        const availableEdges = [];
        for (;;) {
            if (availableEdges.length === 0)
                availableEdges.push(hashUsed++);
            while (hashUsed + 2 >= N.length) {
                N.push(0);
                P.push(0);
                start.push(0);
                twin.push(GARBAGE_EDGE);
            }
            const ei = edges.length;
            edges.push({ start: 0, twin: GARBAGE_EDGE }, { start: 0, twin: GARBAGE_EDGE }, { start: 0, twin: GARBAGE_EDGE });
            const face = [3, start[gi], start[N[gi]], -1];
            if (twin[gi] !== GARBAGE_EDGE && twin[gi] >= 0 && twin[gi] < edges.length)
                edges[twin[gi]].twin = ei;
            edges[ei].twin = twin[gi];
            edges[ei].start = start[gi];
            edges[ei + 1].start = start[N[gi]];
            const op = ops[i++];
            if (op === CASE_C) {
                face[3] = v;
                edges[ei + 1].twin = GARBAGE_EDGE;
                edges[ei + 2].twin = GARBAGE_EDGE;
                edges[ei + 2].start = v;
                const hi = availableEdges.pop();
                N[P[gi]] = hi;
                P[hi] = P[gi];
                N[hi] = gi;
                P[gi] = hi;
                start[hi] = start[gi];
                start[gi] = v;
                twin[gi] = ei + 1;
                twin[hi] = ei + 2;
                v++;
            }
            else if (op === CASE_L) {
                face[3] = start[P[gi]];
                edges[ei + 1].twin = GARBAGE_EDGE;
                edges[ei + 2].twin = twin[P[gi]];
                if (twin[P[gi]] !== GARBAGE_EDGE && twin[P[gi]] >= 0 && twin[P[gi]] < edges.length)
                    edges[twin[P[gi]]].twin = ei + 2;
                edges[ei + 2].start = start[P[gi]];
                start[gi] = start[P[gi]];
                availableEdges.push(P[gi]);
                P[gi] = P[P[gi]];
                N[P[gi]] = gi;
                twin[gi] = ei + 1;
            }
            else if (op === CASE_E) {
                face[3] = start[P[gi]];
                edges[ei + 1].twin = twin[N[gi]];
                if (twin[N[gi]] !== GARBAGE_EDGE && twin[N[gi]] >= 0 && twin[N[gi]] < edges.length)
                    edges[twin[N[gi]]].twin = ei + 1;
                edges[ei + 2].twin = twin[P[gi]];
                if (twin[P[gi]] !== GARBAGE_EDGE && twin[P[gi]] >= 0 && twin[P[gi]] < edges.length)
                    edges[twin[P[gi]]].twin = ei + 2;
                edges[ei + 2].start = start[P[gi]];
                availableEdges.push(gi, P[gi], N[gi]);
                if (isValidFace(face))
                    faces.push(face);
                if (gateStack.length > 0)
                    gi = gateStack.pop();
                else
                    break;
            }
            else if (op === CASE_R) {
                face[3] = start[N[N[gi]]];
                edges[ei + 1].twin = twin[N[gi]];
                if (twin[N[gi]] !== GARBAGE_EDGE && twin[N[gi]] >= 0 && twin[N[gi]] < edges.length)
                    edges[twin[N[gi]]].twin = ei + 1;
                edges[ei + 2].twin = GARBAGE_EDGE;
                edges[ei + 2].start = start[N[N[gi]]];
                availableEdges.push(N[gi]);
                N[gi] = N[N[gi]];
                P[N[gi]] = gi;
                twin[gi] = ei + 2;
            }
            else if (op === CASE_S) {
                let bi = gi;
                const nSteps = (offsets[scount] ?? 0) + 1;
                for (let k = 0; k < nSteps; k++)
                    bi = N[bi];
                face[3] = start[N[bi]];
                edges[ei + 1].twin = GARBAGE_EDGE;
                edges[ei + 2].twin = GARBAGE_EDGE;
                edges[ei + 2].start = start[N[bi]];
                scount++;
                const hi = availableEdges.pop();
                gateStack.push(hi);
                N[P[gi]] = hi;
                P[hi] = P[gi];
                N[hi] = N[bi];
                P[N[bi]] = hi;
                twin[hi] = ei + 2;
                start[hi] = start[gi];
                start[gi] = start[N[bi]];
                twin[gi] = ei + 1;
                P[gi] = bi;
                N[bi] = gi;
            }
            else {
                throw new Error(`Unsupported edgebreaker opcode ${op}.`);
            }
            if (op !== CASE_E) {
                if (isValidFace(face))
                    faces.push(face);
                else
                    throw new Error('Invalid edgebreaker triangle.');
            }
            if (i >= ops.length)
                break;
        }
    }
    return { faces, opcodePointCount: v };
}
function preprocessEdgebreakerOps(ops, start, mtable) {
    let ecount = 0;
    let scount = 0;
    let mcount = 0;
    let m2count = 0;
    const eStack = [];
    const sStack = [];
    const offsets = [];
    for (let i = start; i < ops.length; i++) {
        const op = ops[i];
        if (op === CASE_C)
            ecount -= 1;
        else if (op === CASE_L)
            ecount += 1;
        else if (op === CASE_E) {
            ecount += 3;
            if (eStack.length > 0) {
                const s = sStack.pop();
                offsets[s] = ecount - 2 - eStack.pop();
            }
            else {
                break;
            }
        }
        else if (op === CASE_R)
            ecount += 1;
        else if (op === CASE_S) {
            ecount -= 1;
            sStack.push(scount);
            eStack.push(ecount);
            offsets[scount] = 0;
            scount++;
        }
        else if (op === CASE_M) {
            const length = mtable.mlengths[mcount++] ?? 0;
            ecount -= length + 1;
        }
        else if (op === CASE_M2) {
            const length = mtable.mlengths[m2count] ?? 0;
            ecount -= 1;
            void length;
            m2count++;
        }
        else
            throw new Error(`Bad edgebreaker opcode ${op}.`);
    }
    return { ecount, offsets };
}
function patchEdgebreakerFaces(opcodePointCount, mtable, faces) {
    const pointMap = new Int32Array(opcodePointCount);
    for (const d of mtable.dummies)
        if (d >= 0 && d < opcodePointCount)
            pointMap[d] = POINTMAP_DUMMY;
    for (let i = 0; i + 1 < mtable.patches.length; i += 2) {
        const oldVertex = mtable.patches[i];
        if (oldVertex >= 0 && oldVertex < opcodePointCount && pointMap[oldVertex] !== POINTMAP_DUMMY)
            pointMap[oldVertex] = POINTMAP_ALIAS;
    }
    let shift = 0;
    for (let i = 0; i < opcodePointCount; i++) {
        if (pointMap[i] < 0)
            shift++;
        else
            pointMap[i] = shift;
    }
    const out = [];
    for (const f of faces) {
        const a = f[1], b = f[2], c = f[3];
        if (isDummyOrOutOfRange(a, pointMap) || isDummyOrOutOfRange(b, pointMap) || isDummyOrOutOfRange(c, pointMap))
            continue;
        const mapped = [3, mapPatchedVertex(a, pointMap, mtable), mapPatchedVertex(b, pointMap, mtable), mapPatchedVertex(c, pointMap, mtable)];
        if (isValidFace(mapped))
            out.push(mapped);
    }
    return out;
}
function mapPatchedVertex(v, pointMap, mtable) {
    return pointMap[v] === POINTMAP_ALIAS ? (mtable.patchMap.get(v) ?? v) : v - pointMap[v];
}
function isDummyOrOutOfRange(v, pointMap) {
    return v < 0 || v >= pointMap.length || pointMap[v] === POINTMAP_DUMMY;
}
function isValidFace(face) {
    return face[1] !== face[2] && face[2] !== face[3] && face[3] !== face[1] && face[1] >= 0 && face[2] >= 0 && face[3] >= 0;
}
function readCompressedFaceList(r, pointCount, tristrips, signed) {
    getU8(r); // face-list compression scheme; currently CS_TRIVIAL in supported streams.
    const len = getI32(r);
    if (len <= 0 || r.pos + len > r.bytes.length)
        throw new Error('Bad compressed face-list payload length.');
    const payload = r.bytes.subarray(r.pos, r.pos + len);
    r.pos += len;
    const values = decodeTrivialFaceList(payload, signed);
    const indices = triangulateFaceList(values, pointCount, tristrips);
    return { indices, values };
}
function decodeTrivialFaceList(payload, signed) {
    if (payload.length < 2)
        throw new Error('Face payload is too short.');
    const bits = payload[0];
    const bytesPerSample = bits / 8;
    if (bytesPerSample !== 1 && bytesPerSample !== 2 && bytesPerSample !== 4)
        throw new Error(`Unsupported face-list sample width ${bits}.`);
    const out = [];
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let p = 1; p + bytesPerSample <= payload.length; p += bytesPerSample) {
        if (bytesPerSample === 1)
            out.push(signed ? view.getInt8(p) : view.getUint8(p));
        else if (bytesPerSample === 2)
            out.push(signed ? view.getInt16(p, true) : view.getUint16(p, true));
        else
            out.push(signed ? view.getInt32(p, true) : view.getUint32(p, true));
    }
    return out;
}
function triangulateFaceList(values, pointCount, tristrips) {
    const out = [];
    let i = 0;
    while (i < values.length) {
        const rawCount = values[i++];
        const count = Math.abs(rawCount);
        if (count < 3 || i + count > values.length)
            throw new Error('Invalid face list run.');
        const verts = values.slice(i, i + count);
        i += count;
        if (verts.some(v => v < 0 || v >= pointCount))
            throw new Error('Face index out of range.');
        if (tristrips) {
            if (rawCount > 0) {
                for (let k = 2; k < verts.length; k++) {
                    if ((k & 1) === 0)
                        out.push(verts[k - 2], verts[k - 1], verts[k]);
                    else
                        out.push(verts[k - 1], verts[k - 2], verts[k]);
                }
            }
            else {
                for (let k = 2; k < verts.length; k++)
                    out.push(verts[0], verts[k - 1], verts[k]);
            }
        }
        else if (rawCount > 0) {
            for (let k = 2; k < verts.length; k++)
                out.push(verts[0], verts[k - 1], verts[k]);
        }
    }
    return out;
}
function decodeQuantizedPoints(payload, count, bitsPerSample, bounds) {
    if (bitsPerSample === 8) {
        if (payload.length < count * 3)
            throw new Error('Short 8-bit quantized point payload.');
        const out = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            for (let a = 0; a < 3; a++) {
                const v = payload[i * 3 + a];
                const lo = bounds[a];
                const hi = bounds[a + 3];
                out[i * 3 + a] = v === 255 ? hi : lo + (hi - lo) * (v / 255);
            }
        }
        return out;
    }
    // Generic bit-packed quantization.  HSF stores packed values byte-swapped for 32-bit alignment;
    // MSB-first decoding matches the DWF Toolkit BPack reader after SwapBytes for common >= 6.50 streams.
    const out = new Float32Array(count * 3);
    let bit = 0;
    const max = (1 << bitsPerSample) - 1;
    for (let i = 0; i < count * 3; i++) {
        let raw = 0;
        for (let k = 0; k < bitsPerSample; k++) {
            const b = payload[bit >> 3] ?? 0;
            raw = (raw << 1) | ((b >> (7 - (bit & 7))) & 1);
            bit++;
        }
        const a = i % 3;
        const lo = bounds[a];
        const hi = bounds[a + 3];
        out[i] = raw === max ? hi : lo + (hi - lo) * (raw / max);
    }
    return out;
}
function indexArrayFor(indices, vertexCount) {
    if (vertexCount <= 65535)
        return new Uint16Array(indices);
    return new Uint32Array(indices);
}
function computeVertexNormals(positions, indices) {
    const normals = new Float32Array(positions.length);
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
        const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
        const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
        const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        normals[ia] = (normals[ia] ?? 0) + nx;
        normals[ia + 1] = (normals[ia + 1] ?? 0) + ny;
        normals[ia + 2] = (normals[ia + 2] ?? 0) + nz;
        normals[ib] = (normals[ib] ?? 0) + nx;
        normals[ib + 1] = (normals[ib + 1] ?? 0) + ny;
        normals[ib + 2] = (normals[ib + 2] ?? 0) + nz;
        normals[ic] = (normals[ic] ?? 0) + nx;
        normals[ic + 1] = (normals[ic + 1] ?? 0) + ny;
        normals[ic + 2] = (normals[ic + 2] ?? 0) + nz;
    }
    for (let i = 0; i < normals.length; i += 3) {
        const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        normals[i] = nx / len;
        normals[i + 1] = ny / len;
        normals[i + 2] = nz / len;
    }
    return normals;
}
function computeFeatureEdges(positions, indices, creaseAngleRadians = Math.PI / 5) {
    if (indices.length < 3)
        return undefined;
    const triNormals = [];
    const edges = new Map();
    for (let i = 0, tri = 0; i + 2 < indices.length; i += 3, tri++) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const n = faceNormal(positions, a, b, c);
        triNormals.push(n);
        addEdge(edges, a, b, tri);
        addEdge(edges, b, c, tri);
        addEdge(edges, c, a, tri);
    }
    const threshold = Math.cos(creaseAngleRadians);
    const out = [];
    for (const e of edges.values()) {
        if (e.tris.length === 1) {
            out.push(e.a, e.b);
        }
        else if (e.tris.length >= 2) {
            let sharp = false;
            for (let i = 0; i < e.tris.length && !sharp; i++) {
                for (let j = i + 1; j < e.tris.length; j++) {
                    const na = triNormals[e.tris[i]];
                    const nb = triNormals[e.tris[j]];
                    const dot = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
                    if (dot < threshold) {
                        sharp = true;
                        break;
                    }
                }
            }
            if (sharp)
                out.push(e.a, e.b);
        }
    }
    if (out.length === 0)
        return undefined;
    const vertexCount = Math.floor(positions.length / 3);
    return indexArrayFor(out, vertexCount);
}
function faceNormal(positions, a, b, c) {
    const ia = a * 3, ib = b * 3, ic = c * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    return [nx, ny, nz];
}
function addEdge(edges, a, b, tri) {
    const x = Math.min(a, b), y = Math.max(a, b);
    const key = `${x}:${y}`;
    let e = edges.get(key);
    if (!e) {
        e = { a: x, b: y, tris: [] };
        edges.set(key, e);
    }
    e.tris.push(tri);
}
function computeModelBounds(meshes) {
    if (meshes.length === 0)
        return { min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], radius: 1 };
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const mesh of meshes) {
        for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], mesh.bounds.min[a]);
            max[a] = Math.max(max[a], mesh.bounds.max[a]);
        }
    }
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(1e-6, Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]));
    return { min: min, max: max, center, radius };
}
function boundsFromPositions(positions) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if (x < min[0])
            min[0] = x;
        if (y < min[1])
            min[1] = y;
        if (z < min[2])
            min[2] = z;
        if (x > max[0])
            max[0] = x;
        if (y > max[1])
            max[1] = y;
        if (z > max[2])
            max[2] = z;
    }
    return { min, max };
}
function colorForOrdinal(i) {
    const hue = (i * 0.61803398875) % 1;
    const s = 0.34, l = 0.62;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, hue + 1 / 3), hue2rgb(p, q, hue), hue2rgb(p, q, hue - 1 / 3)];
}
function hue2rgb(p, q, t) {
    if (t < 0)
        t += 1;
    if (t > 1)
        t -= 1;
    if (t < 1 / 6)
        return p + (q - p) * 6 * t;
    if (t < 1 / 2)
        return q;
    if (t < 2 / 3)
        return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}
function readFloat32Array(bytes, offset, count) {
    if (offset + count * 4 > bytes.length)
        throw new Error('Float array exceeds W3D stream length.');
    const out = new Float32Array(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, count * 4);
    for (let i = 0; i < count; i++)
        out[i] = view.getFloat32(i * 4, true);
    return out;
}
function readFloatTuple(r, count) {
    const out = [];
    for (let i = 0; i < count; i++)
        out.push(getF32(r));
    return out;
}
function readIntArray(r, count) {
    const out = [];
    for (let i = 0; i < count; i++)
        out.push(getI32(r));
    return out;
}
function reader(bytes, pos = 0) {
    return { bytes, pos, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}
function getU8(r) {
    if (r.pos >= r.bytes.length)
        throw new Error('Unexpected end of W3D stream.');
    return r.bytes[r.pos++];
}
function getU16(r) { const v = r.view.getUint16(r.pos, true); r.pos += 2; return v; }
function getI32(r) { const v = r.view.getInt32(r.pos, true); r.pos += 4; return v; }
function getF32(r) { const v = r.view.getFloat32(r.pos, true); r.pos += 4; return v; }
function toNext4(i) { return 3 - ((i - 1) % 4); }
