// Swaps the geometry of an original cosmetic's meshes for new parts and gives
// them the original bones. Only Geometry, Cluster and Shape contents change:
// the skeleton, bind pose, materials, textures, ids and connections are
// written back exactly as they were read.
import { Matrix3, Vector3 } from 'three';
import { cloneDoc, writeFbx } from './document.js';
import { child, num, P, str } from './tree.js';
import { transfer } from '../mesh/transfer.js';

const valNode = (name, ...props) => ({ name, props, children: [], block: false, raw: null, dirty: true });
const arrNode = (name, type, values) => ({
    name,
    props: [type === 'i' ? P.i32s(values) : type === 'f' ? { t: 'f', v: Float32Array.from(values) } : P.f64s(values)],
    children: [],
    block: false,
    raw: null,
    dirty: true,
    array: true,
});
// An array node of the same element type (float or double) as the original's.
const arrLike = (orig, name, fallback, values) => {
    const t = orig?.children.find(c => c.name === name)?.props[0]?.t;
    return arrNode(name, t === 'f' || t === 'd' || t === 'i' ? t : fallback, values);
};
const PER_VERTEX = /^(ByVertice|ByVertex|ByControlPoint)$/;
const mappingOf = n => str(child(n, 'MappingInformationType')?.props[0]);

// True when the original stores normals/UVs per control point (as engine
// meshes often do); the new mesh is then split at seams to match.
function perVertexLayers(geom) {
    const els = geom.children.filter(c => /^LayerElement(Normal|UV|Color|Tangent|Binormal)$/.test(c.name));
    return els.length > 0 && els.every(e => PER_VERTEX.test(mappingOf(e)));
}

// parts: [{ id, name, positions, normals, uvs: [uv0, uv1?], index, triMaterial,
//           materialNames, matrix }]
// plan:  Map slotId -> { mode: 'replace' | 'keep' | 'hide', parts: [partId] }
export function compile(original, scene, parts, plan, options = {}) {
    const { doc, map } = cloneDoc(original);
    const byId = new Map(parts.map(p => [p.id, p]));
    const report = [];
    const previews = [];
    const warnings = [];

    for (const slot of scene.slots) {
        const entry = plan.get(slot.id) ?? { mode: 'keep', parts: [] };
        const chosen = entry.parts.map(id => byId.get(id)).filter(Boolean);
        const mode = entry.mode === 'replace' && !chosen.length ? 'keep' : entry.mode;
        if (mode === 'keep') {
            report.push({ slot: slot.name, mode, vertices: slot.data.cpCount, triangles: slot.data.tris.length / 3 });
            continue;
        }
        let mesh = mode === 'hide' ? hiddenMesh(slot) : buildSlotMesh(slot, chosen, options);
        if (perVertexLayers(slot.geomNode)) mesh = splitAtSeams(mesh);
        if (!mesh.cpCount) {
            warnings.push(`${slot.name}: the parts sent here have no triangles, so it was left as it was.`);
            report.push({ slot: slot.name, mode: 'keep', vertices: slot.data.cpCount, triangles: slot.data.tris.length / 3 });
            continue;
        }
        const maxInfluences = options.maxInfluences || slot.maxInfluences || 4;
        const moved = mode === 'hide'
            ? hiddenTransfer(slot)
            : transfer(slot, mesh, { maxInfluences, smooth: options.smooth ?? 0 });
        const tangents = computeTangents(mesh);

        rewriteGeometry(map.get(slot.geomNode), slot, mesh, moved, tangents);
        if (slot.clusters.length) rewriteClusters(slot, map, moved.weights);
        slot.shapes.forEach((shape, k) => rewriteShape(map.get(shape.node), moved.shapes[k]));

        const used = new Set();
        let maxInfl = 0;
        if (moved.weights) {
            const { start, bone } = moved.weights;
            for (let i = 0; i < mesh.cpCount; i++) {
                maxInfl = Math.max(maxInfl, start[i + 1] - start[i]);
                for (let j = start[i]; j < start[i + 1]; j++) used.add(bone[j]);
            }
        }
        const splitVerts = countRenderVertices(mesh);
        if (splitVerts > 65535) warnings.push(`${slot.name}: about ${splitVerts.toLocaleString()} game vertices. Meshes over 65,535 may not import; use a lighter model.`);
        report.push({
            slot: slot.name,
            mode,
            vertices: mesh.cpCount,
            triangles: mesh.tris.length / 3,
            renderVertices: splitVerts,
            bones: used.size,
            maxInfluences: maxInfl,
            maxDistance: moved.maxDist ?? 0,
        });
        previews.push({ slotId: slot.id, mode, mesh, weights: moved.weights });
    }

    const bytes = writeFbx(doc);
    return { doc, bytes, report, previews, warnings };
}

// Merges the parts into one mesh in the slot's geometry space. Control points
// are welded by world position so seams share their skin weights.
export function buildSlotMesh(slot, parts, options = {}) {
    const inv = slot.bind.clone().invert();
    const box = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
    const v = new Vector3();
    for (const part of parts) {
        for (let i = 0; i < part.positions.length; i += 3) {
            v.fromArray(part.positions, i).applyMatrix4(part.matrix);
            box.min.min(v);
            box.max.max(v);
        }
    }
    const tol = Math.max(box.max.distanceTo(box.min) * 1e-6, 1e-9);
    const weld = new Map();
    const cpWorld = [];
    const cpLocal = [];
    const tris = [];
    const normals = [];
    const uv0 = [];
    const uv1 = [];
    const triMat = [];
    let hasUv1 = false;
    const local = new Vector3();
    const nrm = new Vector3();
    const mapMaterial = name => {
        const target = options.materialMap?.get(name);
        const i = slot.materials.findIndex(m => m.name === target);
        if (i >= 0) return i;
        const same = slot.materials.findIndex(m => m.name === name);
        return same >= 0 ? same : 0;
    };

    for (const part of parts) {
        const M = part.matrix;
        const flip = M.determinant() < 0;
        const toLocal = inv.clone().multiply(M);
        const nMat = new Matrix3().getNormalMatrix(toLocal);
        const count = part.positions.length / 3;
        const remap = new Int32Array(count);
        for (let i = 0; i < count; i++) {
            v.fromArray(part.positions, i * 3).applyMatrix4(M);
            const key = Math.round(v.x / tol) + ',' + Math.round(v.y / tol) + ',' + Math.round(v.z / tol);
            let cp = weld.get(key);
            if (cp === undefined) {
                cp = cpWorld.length / 3;
                weld.set(key, cp);
                cpWorld.push(v.x, v.y, v.z);
                local.copy(v).applyMatrix4(inv);
                cpLocal.push(local.x, local.y, local.z);
            }
            remap[i] = cp;
        }
        const matIndex = part.materialNames.map(mapMaterial);
        const uvA = part.uvs[0];
        const uvB = part.uvs[1];
        if (uvB) hasUv1 = true;
        for (let t = 0; t < part.index.length; t += 3) {
            const corner = flip ? [part.index[t], part.index[t + 2], part.index[t + 1]] : [part.index[t], part.index[t + 1], part.index[t + 2]];
            const a = remap[corner[0]], b = remap[corner[1]], c = remap[corner[2]];
            if (a === b || b === c || a === c) continue;
            // Materials packed into a shared texture get their UVs moved into
            // their own rectangle of it.
            const fit = options.uvTransforms?.get(part.materialNames[part.triMaterial?.[t / 3] ?? 0]);
            const pu = u => (fit ? fit.ox + u * fit.sx : u);
            const pv = v => (fit ? fit.oy + v * fit.sy : v);
            for (const vi of corner) {
                tris.push(remap[vi]);
                if (part.normals) nrm.fromArray(part.normals, vi * 3).applyMatrix3(nMat).normalize();
                else nrm.set(0, 1, 0);
                normals.push(nrm.x, nrm.y, nrm.z);
                uv0.push(pu(uvA ? uvA[vi * 2] : 0), pv(uvA ? uvA[vi * 2 + 1] : 0));
                uv1.push(pu(uvB ? uvB[vi * 2] : uvA ? uvA[vi * 2] : 0), pv(uvB ? uvB[vi * 2 + 1] : uvA ? uvA[vi * 2 + 1] : 0));
            }
            triMat.push(matIndex[part.triMaterial?.[t / 3] ?? 0] ?? 0);
        }
    }
    return {
        cpCount: cpWorld.length / 3,
        cpWorld: Float32Array.from(cpWorld),
        cpLocal: Float64Array.from(cpLocal),
        tris: Int32Array.from(tris),
        normals: Float32Array.from(normals),
        uvs: [Float32Array.from(uv0), Float32Array.from(hasUv1 ? uv1 : uv0)],
        triMat: Int32Array.from(triMat),
    };
}

// One control point per distinct (position, normal, UVs) so every attribute
// can be stored per control point.
export function splitAtSeams(mesh) {
    const keys = new Map();
    const cpWorld = [];
    const cpLocal = [];
    const tris = new Int32Array(mesh.tris.length);
    const q = x => Math.round(x * 1e5);
    for (let c = 0; c < mesh.tris.length; c++) {
        const cp = mesh.tris[c];
        const key = `${cp}|${q(mesh.normals[c * 3])},${q(mesh.normals[c * 3 + 1])},${q(mesh.normals[c * 3 + 2])}|` +
            `${q(mesh.uvs[0][c * 2])},${q(mesh.uvs[0][c * 2 + 1])}|${q(mesh.uvs[1][c * 2])},${q(mesh.uvs[1][c * 2 + 1])}`;
        let at = keys.get(key);
        if (at === undefined) {
            at = cpWorld.length / 3;
            keys.set(key, at);
            for (let a = 0; a < 3; a++) {
                cpWorld.push(mesh.cpWorld[cp * 3 + a]);
                cpLocal.push(mesh.cpLocal[cp * 3 + a]);
            }
        }
        tris[c] = at;
    }
    return { ...mesh, cpCount: cpWorld.length / 3, cpWorld: Float32Array.from(cpWorld), cpLocal: Float64Array.from(cpLocal), tris, perVertex: true };
}

// "Hide": a single collapsed triangle keeps the slot (and its skin) valid.
function hiddenMesh(slot) {
    const p = slot.data.positions;
    const w = slot.cpWorld;
    return {
        cpCount: 3,
        cpWorld: Float32Array.from([w[0], w[1], w[2], w[0], w[1], w[2], w[0], w[1], w[2]]),
        cpLocal: Float64Array.from([p[0], p[1], p[2], p[0], p[1], p[2], p[0], p[1], p[2]]),
        tris: Int32Array.from([0, 1, 2]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: [new Float32Array(6), new Float32Array(6)],
        triMat: Int32Array.from([0]),
        hidden: true,
    };
}

function hiddenTransfer(slot) {
    let weights = null;
    if (slot.clusters.length) {
        const { start, bone, value } = slot.weights;
        let cp = 0;
        while (cp < slot.data.cpCount && start[cp + 1] === start[cp]) cp++;
        const b = [];
        const w = [];
        if (cp < slot.data.cpCount) {
            let sum = 0;
            for (let j = start[cp]; j < start[cp + 1]; j++) sum += value[j];
            for (let j = start[cp]; j < start[cp + 1]; j++) {
                b.push(bone[j]);
                w.push(value[j] / sum);
            }
        }
        const n = b.length;
        weights = {
            start: Int32Array.from([0, n, 2 * n, 3 * n]),
            bone: Int32Array.from([...b, ...b, ...b]),
            value: Float64Array.from([...w, ...w, ...w]),
        };
    }
    return {
        weights,
        colors: slot.data.layers.colors.map(() => new Float32Array(12).fill(1)),
        shapes: slot.shapes.map(s => ({ deltas: new Float32Array(9), ndeltas: s.ndeltas ? new Float32Array(9) : null })),
        maxDist: 0,
    };
}

// Per-corner tangents and binormals from UV set 0.
function computeTangents(mesh) {
    const { tris, cpLocal, uvs, normals } = mesh;
    const uv = uvs[0];
    const tanByCp = new Float64Array(mesh.cpCount * 3);
    const bitByCp = new Float64Array(mesh.cpCount * 3);
    for (let t = 0; t < tris.length; t += 3) {
        const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
        const e1 = [0, 1, 2].map(k => cpLocal[b * 3 + k] - cpLocal[a * 3 + k]);
        const e2 = [0, 1, 2].map(k => cpLocal[c * 3 + k] - cpLocal[a * 3 + k]);
        const du1 = uv[(t + 1) * 2] - uv[t * 2], dv1 = uv[(t + 1) * 2 + 1] - uv[t * 2 + 1];
        const du2 = uv[(t + 2) * 2] - uv[t * 2], dv2 = uv[(t + 2) * 2 + 1] - uv[t * 2 + 1];
        const det = du1 * dv2 - du2 * dv1;
        const r = Math.abs(det) > 1e-12 ? 1 / det : 0;
        for (const cp of [a, b, c]) {
            for (let k = 0; k < 3; k++) {
                tanByCp[cp * 3 + k] += (e1[k] * dv2 - e2[k] * dv1) * r;
                bitByCp[cp * 3 + k] += (e2[k] * du1 - e1[k] * du2) * r;
            }
        }
    }
    const tangents = new Float64Array(tris.length * 3);
    const binormals = new Float64Array(tris.length * 3);
    const n = new Vector3(), tg = new Vector3(), bt = new Vector3(), tmp = new Vector3();
    for (let c = 0; c < tris.length; c++) {
        const cp = tris[c];
        n.fromArray(normals, c * 3);
        tg.set(tanByCp[cp * 3], tanByCp[cp * 3 + 1], tanByCp[cp * 3 + 2]);
        bt.set(bitByCp[cp * 3], bitByCp[cp * 3 + 1], bitByCp[cp * 3 + 2]);
        tg.sub(tmp.copy(n).multiplyScalar(n.dot(tg)));
        if (tg.lengthSq() < 1e-20) {
            tg.set(1, 0, 0);
            if (Math.abs(n.x) > 0.9) tg.set(0, 1, 0);
            tg.sub(tmp.copy(n).multiplyScalar(n.dot(tg)));
        }
        tg.normalize();
        const sign = tmp.crossVectors(n, tg).dot(bt) < 0 ? -1 : 1;
        tmp.crossVectors(n, tg).multiplyScalar(sign).normalize();
        tangents.set([tg.x, tg.y, tg.z], c * 3);
        binormals.set([tmp.x, tmp.y, tmp.z], c * 3);
    }
    return { tangents, binormals };
}

function countRenderVertices(mesh) {
    const seen = new Set();
    const { tris, normals, uvs } = mesh;
    for (let c = 0; c < tris.length; c++) {
        seen.add(
            tris[c] + '|' + normals[c * 3].toFixed(3) + ',' + normals[c * 3 + 1].toFixed(3) + ',' + normals[c * 3 + 2].toFixed(3) +
            '|' + uvs[0][c * 2].toFixed(5) + ',' + uvs[0][c * 2 + 1].toFixed(5),
        );
    }
    return seen.size;
}

function dedupe(values, size) {
    const keyOf = i => {
        let s = '';
        for (let k = 0; k < size; k++) s += values[i * size + k] + ',';
        return s;
    };
    const map = new Map();
    const unique = [];
    const index = new Int32Array(values.length / size);
    for (let i = 0; i < index.length; i++) {
        const key = keyOf(i);
        let at = map.get(key);
        if (at === undefined) {
            at = unique.length / size;
            map.set(key, at);
            for (let k = 0; k < size; k++) unique.push(values[i * size + k]);
        }
        index[i] = at;
    }
    return { unique: Float64Array.from(unique), index };
}

function layerElement(orig, mapping, ref, data) {
    const version = orig.children.find(c => c.name === 'Version') ?? valNode('Version', P.i32(101));
    const name = orig.children.find(c => c.name === 'Name') ?? valNode('Name', P.str(''));
    return {
        ...orig,
        children: [version, name, valNode('MappingInformationType', P.str(mapping)), valNode('ReferenceInformationType', P.str(ref)), ...data],
        block: true,
    };
}

function refOf(orig, fallback = 'IndexToDirect') {
    const ref = str(child(orig, 'ReferenceInformationType')?.props[0]);
    if (ref === 'Direct') return 'Direct';
    if (ref === 'IndexToDirect' || ref === 'Index') return 'IndexToDirect';
    return fallback;
}

function rewriteGeometry(g, slot, mesh, moved, { tangents, binormals }) {
    const corners = mesh.tris.length;
    const polyCount = corners / 3;
    const pvi = new Int32Array(corners);
    for (let c = 0; c < corners; c++) pvi[c] = c % 3 === 2 ? ~mesh.tris[c] : mesh.tris[c];
    const written = new Set();
    const out = [];

    // Per-corner values, or per control point when the original stored them so.
    const perCp = (values, size) => {
        const res = new Float64Array(mesh.cpCount * size);
        for (let c = 0; c < corners; c++) for (let k = 0; k < size; k++) res[mesh.tris[c] * size + k] = values[c * size + k];
        return res;
    };
    const layer = (c, field, indexName, values, size, withW) => {
        const byCp = mesh.perVertex && PER_VERTEX.test(mappingOf(c));
        const data = byCp ? perCp(values, size) : values;
        const items = data.length / size;
        const ref = indexName ? refOf(c, field === 'Normals' || field === 'Tangents' || field === 'Binormals' ? 'Direct' : 'IndexToDirect') : 'Direct';
        const nodes = [];
        if (ref === 'IndexToDirect') {
            const { unique, index } = dedupe(data, size);
            nodes.push(arrLike(c, field, 'd', unique), arrLike(c, indexName, 'i', index));
        } else {
            nodes.push(arrLike(c, field, 'd', data));
        }
        if (withW && child(c, field + 'W')) nodes.push(arrLike(c, field + 'W', 'd', new Float64Array(ref === 'IndexToDirect' ? nodes[0].props[0].v.length / size : items).fill(1)));
        return layerElement(c, byCp ? mappingOf(c) : 'ByPolygonVertex', ref, nodes);
    };

    for (const c of g.children) {
        const idx = num(c.props[0]) ?? 0;
        switch (c.name) {
            case 'Vertices':
                out.push(arrLike(g, 'Vertices', 'd', mesh.cpLocal));
                break;
            case 'PolygonVertexIndex':
                out.push(arrLike(g, 'PolygonVertexIndex', 'i', pvi));
                break;
            case 'Edges':
                out.push(arrLike(g, 'Edges', 'i', edgesOf(mesh.tris)));
                break;
            case 'LayerElementNormal':
            case 'LayerElementTangent':
            case 'LayerElementBinormal': {
                if (idx !== 0) break;
                const [field, values] = c.name === 'LayerElementNormal'
                    ? ['Normals', Float64Array.from(mesh.normals)]
                    : c.name === 'LayerElementTangent' ? ['Tangents', tangents] : ['Binormals', binormals];
                out.push(layer(c, field, field + 'Index', values, 3, true));
                written.add(c.name + ':' + idx);
                break;
            }
            case 'LayerElementUV': {
                out.push(layer(c, 'UV', 'UVIndex', Float64Array.from(mesh.uvs[Math.min(idx, 1)]), 2, false));
                written.add(c.name + ':' + idx);
                break;
            }
            case 'LayerElementColor': {
                const k = slot.data.layers.colors.findIndex(l => l.index === idx);
                const source = moved.colors[k >= 0 ? k : 0];
                if (!source) break;
                const perCorner = new Float64Array(corners * 4);
                for (let n = 0; n < corners; n++) for (let a = 0; a < 4; a++) perCorner[n * 4 + a] = source[mesh.tris[n] * 4 + a];
                out.push(layer(c, 'Colors', 'ColorIndex', perCorner, 4, false));
                written.add(c.name + ':' + idx);
                break;
            }
            case 'LayerElementMaterial': {
                if (idx !== 0) break;
                const first = mesh.triMat[0] ?? 0;
                const same = mesh.triMat.every(m => m === first);
                const allSame = same && mappingOf(c) === 'AllSame';
                out.push(layerElement(c, allSame ? 'AllSame' : 'ByPolygon', 'IndexToDirect', [
                    arrLike(c, 'Materials', 'i', allSame ? Int32Array.of(first) : mesh.triMat),
                ]));
                written.add(c.name + ':' + idx);
                break;
            }
            case 'LayerElementSmoothing': {
                if (idx !== 0) break;
                out.push(layerElement(c, 'ByPolygon', 'Direct', [arrLike(c, 'Smoothing', 'i', new Int32Array(polyCount).fill(1))]));
                written.add(c.name + ':' + idx);
                break;
            }
            case 'Layer':
                out.push(c);
                break;
            default:
                // Other per-vertex layers can't follow the new topology.
                if (c.name.startsWith('LayerElement')) break;
                out.push(c);
        }
    }
    for (const layerNode of out.filter(c => c.name === 'Layer')) {
        layerNode.children = layerNode.children.filter(e => {
            if (e.name !== 'LayerElement') return true;
            const type = str(child(e, 'Type')?.props[0]);
            const typed = num(child(e, 'TypedIndex')?.props[0]) ?? 0;
            return written.has(type + ':' + typed);
        });
    }
    g.children = out;
}

function edgesOf(tris) {
    const seen = new Set();
    const edges = [];
    for (let c = 0; c < tris.length; c++) {
        const a = tris[c];
        const b = tris[c % 3 === 2 ? c - 2 : c + 1];
        const key = a < b ? a + ',' + b : b + ',' + a;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(c);
    }
    return Int32Array.from(edges);
}

function rewriteClusters(slot, map, weights) {
    const lists = slot.clusters.map(() => ({ idx: [], w: [] }));
    if (weights) {
        const { start, bone, value } = weights;
        for (let i = 0; i + 1 < start.length; i++) {
            for (let j = start[i]; j < start[i + 1]; j++) {
                lists[bone[j]].idx.push(i);
                lists[bone[j]].w.push(value[j]);
            }
        }
    }
    slot.clusters.forEach((cluster, k) => {
        const n = map.get(cluster.node);
        const kept = n.children.filter(c => c.name !== 'Indexes' && c.name !== 'Weights');
        const at = kept.findIndex(c => c.name === 'Transform');
        const insert = lists[k].idx.length
            ? [arrLike(cluster.node, 'Indexes', 'i', Int32Array.from(lists[k].idx)), arrLike(cluster.node, 'Weights', 'd', Float64Array.from(lists[k].w))]
            : [];
        kept.splice(at >= 0 ? at : kept.length, 0, ...insert);
        n.children = kept;
        n.block = true;
    });
}

function rewriteShape(n, moved) {
    if (!n || !moved) return;
    const idx = [];
    const dv = [];
    const dn = [];
    const count = moved.deltas.length / 3;
    for (let i = 0; i < count; i++) {
        const x = moved.deltas[i * 3], y = moved.deltas[i * 3 + 1], z = moved.deltas[i * 3 + 2];
        if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-7) continue;
        idx.push(i);
        dv.push(x, y, z);
        if (moved.ndeltas) dn.push(moved.ndeltas[i * 3], moved.ndeltas[i * 3 + 1], moved.ndeltas[i * 3 + 2]);
    }
    if (!idx.length) {
        idx.push(0);
        dv.push(0, 0, 0);
        dn.push(0, 0, 0);
    }
    const replace = {
        Indexes: arrLike(n, 'Indexes', 'i', Int32Array.from(idx)),
        Vertices: arrLike(n, 'Vertices', 'd', Float64Array.from(dv)),
        Normals: arrLike(n, 'Normals', 'd', Float64Array.from(dn.length ? dn : new Array(dv.length).fill(0))),
    };
    const out = [];
    for (const c of n.children) {
        if (replace[c.name]) {
            out.push(replace[c.name]);
            delete replace[c.name];
        } else {
            out.push(c);
        }
    }
    if (replace.Indexes) out.push(replace.Indexes);
    if (replace.Vertices) out.push(replace.Vertices);
    n.children = out;
    n.block = true;
}

// Picks, in each LOD, the original mesh each part sits closest to.
export function autoPlan(scene, parts, meanDistanceFn) {
    const plan = new Map(scene.slots.map(s => [s.id, { mode: 'keep', parts: [] }]));
    const lods = new Map();
    for (const s of scene.slots) {
        if (!lods.has(s.lod)) lods.set(s.lod, []);
        lods.get(s.lod).push(s);
    }
    for (const part of parts) {
        const sample = samplePoints(part, 400);
        for (const group of lods.values()) {
            let best = null;
            let bestD = Infinity;
            for (const s of group) {
                const d = group.length === 1 ? 0 : meanDistanceFn(s, sample);
                if (d < bestD) {
                    bestD = d;
                    best = s;
                }
            }
            if (best) {
                const e = plan.get(best.id);
                e.mode = 'replace';
                e.parts.push(part.id);
            }
        }
    }
    return plan;
}

export function samplePoints(part, max) {
    const count = part.positions.length / 3;
    const step = Math.max(1, Math.floor(count / max));
    const out = [];
    const v = new Vector3();
    for (let i = 0; i < count; i += step) {
        v.fromArray(part.positions, i * 3).applyMatrix4(part.matrix);
        out.push(v.x, v.y, v.z);
    }
    return Float32Array.from(out);
}
