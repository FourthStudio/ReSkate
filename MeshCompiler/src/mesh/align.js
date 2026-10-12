// Placing a new part on an original piece: try every 90-degree orientation,
// size it to the piece's bounds, score how well it sits on the surface, and
// nudge it into place.
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { TriangleGrid } from './grid.js';

// The 24 rotations that map axes onto axes.
const ROTATIONS = (() => {
    const out = [];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const p of perms) {
        for (let s = 0; s < 8; s++) {
            const sign = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
            const m = new Matrix4();
            const e = new Array(16).fill(0);
            for (let r = 0; r < 3; r++) e[p[r] * 4 + r] = sign[r];
            e[15] = 1;
            m.fromArray(e);
            if (m.determinant() > 0) out.push(m);
        }
    }
    return out;
})();

export function pieceGrid(slot, piece) {
    if (!piece._grid) {
        const { tris, cpOfCorner } = slot.data;
        const t = new Int32Array(piece.tris.length * 3);
        piece.tris.forEach((tri, i) => {
            for (let k = 0; k < 3; k++) t[i * 3 + k] = cpOfCorner[tris[tri * 3 + k]];
        });
        piece._grid = new TriangleGrid(slot.cpWorld, t);
        // Surface samples of the piece for the reverse distance.
        const step = Math.max(1, Math.floor(piece.tris.length / 300));
        const s = [];
        for (let i = 0; i < piece.tris.length; i += step) {
            for (let a = 0; a < 3; a++) s.push((slot.cpWorld[t[i * 3] * 3 + a] + slot.cpWorld[t[i * 3 + 1] * 3 + a] + slot.cpWorld[t[i * 3 + 2] * 3 + a]) / 3);
        }
        piece._samples = Float32Array.from(s);
    }
    return piece._grid;
}

function samples(part, max) {
    const n = part.positions.length / 3;
    const step = Math.max(1, Math.floor(n / max));
    const out = [];
    for (let i = 0; i < n; i += step) out.push(part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]);
    return Float32Array.from(out);
}

function boundsOf(points, m) {
    const box = new Box3();
    const v = new Vector3();
    for (let i = 0; i < points.length; i += 3) box.expandByPoint(v.fromArray(points, i).applyMatrix4(m));
    return box;
}

// Uniform scale and translation that put `box` onto `target`.
function fitBox(box, target) {
    const s = box.getSize(new Vector3());
    const t = target.getSize(new Vector3());
    const ratios = [0, 1, 2].map(a => (s.getComponent(a) > 1e-9 && t.getComponent(a) > 1e-9 ? t.getComponent(a) / s.getComponent(a) : null)).filter(Boolean);
    const scale = ratios.length ? ratios.reduce((x, y) => x * y, 1) ** (1 / ratios.length) : 1;
    const c = box.getCenter(new Vector3()).multiplyScalar(scale);
    const offset = target.getCenter(new Vector3()).sub(c);
    return { scale, offset };
}

function score(grid, targetSamples, pts, m) {
    const hit = {};
    const v = new Vector3();
    const moved = new Float32Array(pts.length);
    let a = 0;
    for (let i = 0; i < pts.length; i += 3) {
        v.fromArray(pts, i).applyMatrix4(m);
        moved[i] = v.x;
        moved[i + 1] = v.y;
        moved[i + 2] = v.z;
        grid.closest(v.x, v.y, v.z, hit);
        a += Math.sqrt(hit.d2);
    }
    a /= pts.length / 3;
    let b = 0;
    for (let i = 0; i < targetSamples.length; i += 3) {
        let best = Infinity;
        for (let j = 0; j < moved.length; j += 3) {
            const d = (moved[j] - targetSamples[i]) ** 2 + (moved[j + 1] - targetSamples[i + 1]) ** 2 + (moved[j + 2] - targetSamples[i + 2]) ** 2;
            if (d < best) best = d;
        }
        b += Math.sqrt(best);
    }
    b /= Math.max(1, targetSamples.length / 3);
    return a + b;
}

// Returns the part's new local -> world matrix. `keepMirror` keeps a mirrored
// part mirrored.
export function autoAlign(part, slot, piece, keepMirror = false) {
    const grid = pieceGrid(slot, piece);
    const pts = samples(part, 500);
    const target = new Box3(piece.min.clone(), piece.max.clone());
    const mirror = keepMirror ? new Matrix4().makeScale(-1, 1, 1) : new Matrix4();
    let best = null;
    for (const R of ROTATIONS) {
        const base = R.clone().multiply(mirror);
        const { scale, offset } = fitBox(boundsOf(pts, base), target);
        const m = new Matrix4().makeTranslation(offset.x, offset.y, offset.z).multiply(new Matrix4().makeScale(scale, scale, scale)).multiply(base);
        const s = score(grid, piece._samples, pts, m);
        if (!best || s < best.s) best = { s, m };
    }
    return refine(best.m, grid, pts);
}

// Keeps the part's rotation; sizes and centres it on the piece.
export function fitToPiece(part, matrix, piece) {
    const pos = new Vector3();
    const rot = new Quaternion();
    const scl = new Vector3();
    matrix.decompose(pos, rot, scl);
    const unit = Math.max(Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z)) || 1;
    const base = new Matrix4().compose(new Vector3(), rot, scl.clone().divideScalar(unit));
    const pts = samples(part, 4000);
    const { scale, offset } = fitBox(boundsOf(pts, base), new Box3(piece.min.clone(), piece.max.clone()));
    return new Matrix4().makeTranslation(offset.x, offset.y, offset.z).multiply(new Matrix4().makeScale(scale, scale, scale)).multiply(base);
}

// A few translation-only closest-point steps.
function refine(m, grid, pts) {
    const out = m.clone();
    const hit = {};
    const v = new Vector3();
    for (let it = 0; it < 6; it++) {
        const shift = new Vector3();
        let n = 0;
        for (let i = 0; i < pts.length; i += 3) {
            v.fromArray(pts, i).applyMatrix4(out);
            grid.closest(v.x, v.y, v.z, hit);
            shift.x += hit.x - v.x;
            shift.y += hit.y - v.y;
            shift.z += hit.z - v.z;
            n++;
        }
        shift.divideScalar(n || 1).multiplyScalar(0.5);
        if (shift.lengthSq() < 1e-14) break;
        out.premultiply(new Matrix4().makeTranslation(shift.x, shift.y, shift.z));
    }
    return out;
}

export function mirrorMatrix(axis, offset) {
    const s = [1, 1, 1];
    s[axis] = -1;
    const t = [0, 0, 0];
    t[axis] = offset;
    return new Matrix4().makeTranslation(t[0], t[1], t[2])
        .multiply(new Matrix4().makeScale(s[0], s[1], s[2]))
        .multiply(new Matrix4().makeTranslation(-t[0], -t[1], -t[2]));
}
