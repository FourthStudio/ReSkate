// Uniform grid over a triangle soup for closest-point queries.

export class TriangleGrid {
    // positions: Float32Array xyz per vertex; tris: vertex index triplets.
    constructor(positions, tris) {
        this.p = positions;
        this.t = tris;
        const n = tris.length / 3;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < tris.length; i++) {
            const v = tris[i] * 3;
            for (let a = 0; a < 3; a++) {
                min[a] = Math.min(min[a], positions[v + a]);
                max[a] = Math.max(max[a], positions[v + a]);
            }
        }
        const size = max.map((m, a) => Math.max(m - min[a], 1e-9));
        const volume = size[0] * size[1] * size[2];
        let cell = Math.cbrt(volume / Math.max(n, 1)) * 1.5;
        const longest = Math.max(...size);
        cell = Math.max(cell, longest / 96, 1e-9);
        this.cell = cell;
        this.min = min;
        this.dims = size.map(s => Math.max(1, Math.min(128, Math.ceil(s / cell))));
        const [nx, ny, nz] = this.dims;
        const counts = new Int32Array(nx * ny * nz + 1);
        const ranges = new Int32Array(n * 6);
        for (let t = 0; t < n; t++) {
            for (let a = 0; a < 3; a++) {
                let lo = Infinity;
                let hi = -Infinity;
                for (let k = 0; k < 3; k++) {
                    const c = positions[tris[t * 3 + k] * 3 + a];
                    lo = Math.min(lo, c);
                    hi = Math.max(hi, c);
                }
                ranges[t * 6 + a] = this.clampCell(a, Math.floor((lo - min[a]) / cell));
                ranges[t * 6 + 3 + a] = this.clampCell(a, Math.floor((hi - min[a]) / cell));
            }
            for (let x = ranges[t * 6]; x <= ranges[t * 6 + 3]; x++)
                for (let y = ranges[t * 6 + 1]; y <= ranges[t * 6 + 4]; y++)
                    for (let z = ranges[t * 6 + 2]; z <= ranges[t * 6 + 5]; z++) counts[(z * ny + y) * nx + x + 1]++;
        }
        for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
        const fill = counts.slice(0, -1);
        const items = new Int32Array(counts[counts.length - 1]);
        for (let t = 0; t < n; t++) {
            for (let x = ranges[t * 6]; x <= ranges[t * 6 + 3]; x++)
                for (let y = ranges[t * 6 + 1]; y <= ranges[t * 6 + 4]; y++)
                    for (let z = ranges[t * 6 + 2]; z <= ranges[t * 6 + 5]; z++) items[fill[(z * ny + y) * nx + x]++] = t;
        }
        this.start = counts;
        this.items = items;
        this.stamp = new Uint32Array(n);
        this.query = 0;
    }

    clampCell(a, c) {
        return c < 0 ? 0 : c >= this.dims[a] ? this.dims[a] - 1 : c;
    }

    // Returns { tri, u, v, w, d2, x, y, z } with barycentric weights of the
    // closest point on the closest triangle.
    closest(px, py, pz, out = {}) {
        const { cell, min, dims, start, items, stamp } = this;
        const [nx, ny, nz] = dims;
        if (++this.query === 0xffffffff) {
            stamp.fill(0);
            this.query = 1;
        }
        const q = this.query;
        const cx = this.clampCell(0, Math.floor((px - min[0]) / cell));
        const cy = this.clampCell(1, Math.floor((py - min[1]) / cell));
        const cz = this.clampCell(2, Math.floor((pz - min[2]) / cell));
        out.d2 = Infinity;
        out.tri = -1;
        const res = { u: 0, v: 0, w: 0, x: 0, y: 0, z: 0 };
        const maxR = Math.max(nx, ny, nz);
        for (let r = 0; r <= maxR; r++) {
            const x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r, z0 = cz - r, z1 = cz + r;
            for (let z = Math.max(z0, 0); z <= Math.min(z1, nz - 1); z++) {
                for (let y = Math.max(y0, 0); y <= Math.min(y1, ny - 1); y++) {
                    const shell = z === z0 || z === z1 || y === y0 || y === y1;
                    for (let x = Math.max(x0, 0); x <= Math.min(x1, nx - 1); x++) {
                        if (!shell && x !== x0 && x !== x1) continue;
                        const ci = (z * ny + y) * nx + x;
                        for (let k = start[ci]; k < start[ci + 1]; k++) {
                            const t = items[k];
                            if (stamp[t] === q) continue;
                            stamp[t] = q;
                            const d2 = this.closestOnTri(t, px, py, pz, res);
                            if (d2 < out.d2) {
                                out.d2 = d2;
                                out.tri = t;
                                out.u = res.u;
                                out.v = res.v;
                                out.w = res.w;
                                out.x = res.x;
                                out.y = res.y;
                                out.z = res.z;
                            }
                        }
                    }
                }
            }
            if (out.tri >= 0) {
                // Smallest distance to any cell not searched yet.
                let lb = Infinity;
                const coords = [px, py, pz];
                const c = [cx, cy, cz];
                for (let a = 0; a < 3; a++) {
                    if (c[a] - r > 0) lb = Math.min(lb, Math.max(0, coords[a] - (min[a] + (c[a] - r) * cell)));
                    if (c[a] + r < dims[a] - 1) lb = Math.min(lb, Math.max(0, min[a] + (c[a] + r + 1) * cell - coords[a]));
                }
                if (lb === Infinity || out.d2 <= lb * lb) break;
            }
        }
        return out;
    }

    // Ericson, Real-Time Collision Detection 5.1.5.
    closestOnTri(t, px, py, pz, res) {
        const p = this.p;
        const ia = this.t[t * 3] * 3, ib = this.t[t * 3 + 1] * 3, ic = this.t[t * 3 + 2] * 3;
        const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
        const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
        const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;
        const apx = px - ax, apy = py - ay, apz = pz - az;
        const d1 = abx * apx + aby * apy + abz * apz;
        const d2 = acx * apx + acy * apy + acz * apz;
        let u, v, w;
        if (d1 <= 0 && d2 <= 0) {
            u = 1; v = 0; w = 0;
        } else {
            const bpx = px - bx, bpy = py - by, bpz = pz - bz;
            const d3 = abx * bpx + aby * bpy + abz * bpz;
            const d4 = acx * bpx + acy * bpy + acz * bpz;
            if (d3 >= 0 && d4 <= d3) {
                u = 0; v = 1; w = 0;
            } else {
                const vc = d1 * d4 - d3 * d2;
                if (vc <= 0 && d1 >= 0 && d3 <= 0) {
                    const s = d1 / (d1 - d3);
                    u = 1 - s; v = s; w = 0;
                } else {
                    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
                    const d5 = abx * cpx + aby * cpy + abz * cpz;
                    const d6 = acx * cpx + acy * cpy + acz * cpz;
                    if (d6 >= 0 && d5 <= d6) {
                        u = 0; v = 0; w = 1;
                    } else {
                        const vb = d5 * d2 - d1 * d6;
                        if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                            const s = d2 / (d2 - d6);
                            u = 1 - s; v = 0; w = s;
                        } else {
                            const va = d3 * d6 - d5 * d4;
                            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                                const s = (d4 - d3) / (d4 - d3 + (d5 - d6));
                                u = 0; v = 1 - s; w = s;
                            } else {
                                const denom = 1 / (va + vb + vc);
                                v = vb * denom;
                                w = vc * denom;
                                u = 1 - v - w;
                                if (!Number.isFinite(u)) {
                                    u = 1; v = 0; w = 0;
                                }
                            }
                        }
                    }
                }
            }
        }
        res.u = u;
        res.v = v;
        res.w = w;
        res.x = u * ax + v * bx + w * cx;
        res.y = u * ay + v * by + w * cy;
        res.z = u * az + v * bz + w * cz;
        const dx = px - res.x, dy = py - res.y, dz = pz - res.z;
        return dx * dx + dy * dy + dz * dz;
    }
}
