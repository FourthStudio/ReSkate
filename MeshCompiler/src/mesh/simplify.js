// Reduces a part to a triangle budget with meshoptimizer, one material at a
// time so every triangle keeps its material. UV and normal seams are kept.
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';

export async function simplifyPart(part, targetTris) {
    const total = part.index.length / 3;
    if (!(targetTris > 0) || targetTris >= total) return part;
    await MeshoptSimplifier.ready;
    const ratio = targetTris / total;
    const vertexCount = part.positions.length / 3;
    const uv = part.uvs[0];
    // Attributes the simplifier tries to keep: normal (xyz) and UV.
    const attrs = new Float32Array(vertexCount * 5);
    for (let i = 0; i < vertexCount; i++) {
        attrs.set(part.normals.subarray(i * 3, i * 3 + 3), i * 5);
        attrs[i * 5 + 3] = uv ? uv[i * 2] : 0;
        attrs[i * 5 + 4] = uv ? uv[i * 2 + 1] : 0;
    }
    const weights = [0.5, 0.5, 0.5, 1, 1];
    const byMaterial = new Map();
    for (let t = 0; t < total; t++) {
        const m = part.triMaterial[t];
        if (!byMaterial.has(m)) byMaterial.set(m, []);
        byMaterial.get(m).push(t);
    }
    const index = [];
    const triMaterial = [];
    for (const [m, tris] of byMaterial) {
        const sub = new Uint32Array(tris.length * 3);
        tris.forEach((t, i) => sub.set(part.index.subarray(t * 3, t * 3 + 3), i * 3));
        const target = Math.max(1, Math.round(tris.length * ratio)) * 3;
        let [out] = MeshoptSimplifier.simplifyWithAttributes(sub, part.positions, 3, attrs, 5, weights, null, target, 1, []);
        if (!out.length) out = sub; // tiny pieces can collapse to nothing; keep them
        for (let i = 0; i < out.length; i++) index.push(out[i]);
        for (let i = 0; i < out.length / 3; i++) triMaterial.push(m);
    }
    // Drop unused vertices, keeping their order so source pieces stay
    // contiguous vertex ranges.
    const remap = new Int32Array(vertexCount).fill(-1);
    for (const v of index) remap[v] = 0;
    let used = 0;
    for (let v = 0; v < vertexCount; v++) if (remap[v] === 0) remap[v] = used++;
    const take = (src, size) => {
        if (!src) return null;
        const dst = new Float32Array(used * size);
        for (let v = 0; v < vertexCount; v++) if (remap[v] >= 0) dst.set(src.subarray(v * size, v * size + size), remap[v] * size);
        return dst;
    };
    const pieces = (part.pieces ?? []).map(p => {
        let start = -1;
        let end = -1;
        for (let v = p.vertexStart; v < p.vertexStart + p.vertexCount; v++) {
            if (remap[v] < 0) continue;
            if (start < 0) start = remap[v];
            end = remap[v] + 1;
        }
        return { name: p.name, vertexStart: Math.max(start, 0), vertexCount: start < 0 ? 0 : end - start };
    }).filter(p => p.vertexCount > 0);
    return {
        ...part,
        positions: take(part.positions, 3),
        normals: take(part.normals, 3),
        uvs: part.uvs.map(u => take(u, 2)),
        index: Uint32Array.from(index, v => remap[v]),
        triMaterial: Int32Array.from(triMaterial),
        pieces,
    };
}
