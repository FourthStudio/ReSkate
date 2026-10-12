// Carries skin weights, vertex colours and blend shapes from an original mesh
// slot onto new geometry, through the closest point on the original surface.
import { TriangleGrid } from './grid.js';

export function slotGrid(slot) {
    if (!slot._grid) {
        const { tris, cpOfCorner } = slot.data;
        const cpTris = new Int32Array(tris.length);
        for (let i = 0; i < tris.length; i++) cpTris[i] = cpOfCorner[tris[i]];
        slot._grid = new TriangleGrid(slot.cpWorld, cpTris);
    }
    return slot._grid;
}

// Mean distance from sample points (world xyz) to a slot's surface.
export function meanDistance(slot, points, step = 1) {
    const grid = slotGrid(slot);
    const hit = {};
    let sum = 0;
    let n = 0;
    for (let i = 0; i < points.length; i += 3 * step) {
        grid.closest(points[i], points[i + 1], points[i + 2], hit);
        sum += Math.sqrt(hit.d2);
        n++;
    }
    return n ? sum / n : Infinity;
}

// mesh: { cpCount, cpWorld, tris (cp triplets) }
// Returns weights as compressed rows (bone = cluster index), per-cp colours
// for each original colour set, per-cp shape deltas, and the hits.
export function transfer(slot, mesh, { maxInfluences = 4, smooth = 0 } = {}) {
    const grid = slotGrid(slot);
    const { tris, layers } = slot.data;
    const clusters = slot.clusters.length;
    const K = Math.max(1, Math.min(8, maxInfluences));
    const n = mesh.cpCount;
    const hits = new Array(n);
    let maxDist = 0;
    for (let i = 0; i < n; i++) {
        const h = grid.closest(mesh.cpWorld[i * 3], mesh.cpWorld[i * 3 + 1], mesh.cpWorld[i * 3 + 2], {});
        hits[i] = h;
        maxDist = Math.max(maxDist, Math.sqrt(h.d2));
    }
    const cornerOf = (h, k) => tris[h.tri * 3 + k];
    const cpOf = (h, k) => slot.data.cpOfCorner[cornerOf(h, k)];
    const bary = h => [h.u, h.v, h.w];

    // Weights
    let weights = null;
    if (clusters) {
        const { start, bone, value } = slot.weights;
        // One sparse row (cluster -> weight) per new control point.
        let rows = new Array(n);
        for (let i = 0; i < n; i++) {
            const row = new Map();
            const h = hits[i];
            const b = bary(h);
            for (let k = 0; k < 3; k++) {
                if (b[k] <= 0) continue;
                const cp = cpOf(h, k);
                let sum = 0;
                for (let j = start[cp]; j < start[cp + 1]; j++) sum += value[j];
                if (sum <= 0) continue;
                for (let j = start[cp]; j < start[cp + 1]; j++) row.set(bone[j], (row.get(bone[j]) ?? 0) + (b[k] * value[j]) / sum);
            }
            // A point that landed on unweighted original vertices borrows from
            // the nearest weighted one.
            if (!row.size) {
                const cp = nearestWeightedCp(slot, mesh.cpWorld[i * 3], mesh.cpWorld[i * 3 + 1], mesh.cpWorld[i * 3 + 2]);
                if (cp >= 0) for (let j = start[cp]; j < start[cp + 1]; j++) row.set(bone[j], (row.get(bone[j]) ?? 0) + value[j]);
            }
            rows[i] = limit(row, K);
        }
        if (smooth > 0) {
            const nb = neighbours(n, mesh.tris);
            for (let it = 0; it < smooth; it++) {
                rows = rows.map((row, i) => {
                    const list = nb[i];
                    if (!list.length) return row;
                    const out = new Map();
                    for (const [c, w] of row) out.set(c, 0.5 * w);
                    const share = 0.5 / list.length;
                    for (const j of list) for (const [c, w] of rows[j]) out.set(c, (out.get(c) ?? 0) + share * w);
                    return limit(out, K);
                });
            }
        }
        const rowStart = new Int32Array(n + 1);
        const rowBone = [];
        const rowValue = [];
        for (let i = 0; i < n; i++) {
            for (const [c, w] of [...rows[i]].sort((a, b) => a[0] - b[0])) {
                rowBone.push(c);
                rowValue.push(w);
            }
            rowStart[i + 1] = rowBone.length;
        }
        weights = { start: rowStart, bone: Int32Array.from(rowBone), value: Float64Array.from(rowValue) };
    }

    // Vertex colours, one per control point.
    const colors = layers.colors.map(layer => {
        const out = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const h = hits[i];
            const b = bary(h);
            for (let k = 0; k < 3; k++) {
                const at = layer.at(cornerOf(h, k)) * 4;
                for (let a = 0; a < 4; a++) out[i * 4 + a] += b[k] * (layer.data[at + a] ?? 1);
            }
        }
        return out;
    });

    // Blend shape deltas (slot geometry space, which the new mesh shares).
    const shapes = slot.shapes.map(shape => {
        const deltas = new Float32Array(n * 3);
        const ndeltas = shape.ndeltas ? new Float32Array(n * 3) : null;
        for (let i = 0; i < n; i++) {
            const h = hits[i];
            const b = bary(h);
            for (let k = 0; k < 3; k++) {
                const cp = cpOf(h, k);
                for (let a = 0; a < 3; a++) {
                    deltas[i * 3 + a] += b[k] * shape.deltas[cp * 3 + a];
                    if (ndeltas) ndeltas[i * 3 + a] += b[k] * shape.ndeltas[cp * 3 + a];
                }
            }
        }
        return { deltas, ndeltas };
    });

    return { weights, colors, shapes, maxDist };
}

function nearestWeightedCp(slot, x, y, z) {
    const { start } = slot.weights;
    const p = slot.cpWorld;
    let best = -1;
    let bestD = Infinity;
    for (let cp = 0; cp < slot.data.cpCount; cp++) {
        if (start[cp + 1] === start[cp]) continue;
        const d = (p[cp * 3] - x) ** 2 + (p[cp * 3 + 1] - y) ** 2 + (p[cp * 3 + 2] - z) ** 2;
        if (d < bestD) {
            bestD = d;
            best = cp;
        }
    }
    return best;
}

// Keep the K largest influences of a row and make them sum to one.
function limit(row, K) {
    const list = [...row].filter(([, w]) => w > 1e-6).sort((a, b) => b[1] - a[1]).slice(0, K);
    const sum = list.reduce((s, [, w]) => s + w, 0);
    return new Map(sum > 0 ? list.map(([c, w]) => [c, w / sum]) : []);
}

function neighbours(n, tris) {
    const sets = Array.from({ length: n }, () => new Set());
    for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        sets[a].add(b).add(c);
        sets[b].add(a).add(c);
        sets[c].add(a).add(b);
    }
    return sets.map(s => [...s]);
}
