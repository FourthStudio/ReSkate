// Reads what the compiler needs from an FBX node tree: the skinned meshes
// ("slots") in bind pose, their skin clusters and blend shapes, the skeleton,
// and the materials. Everything is placed in FBX world space at bind time.
import { Euler, MathUtils, Matrix3, Matrix4, Vector3 } from 'three';
import { arr, child, childArr, childrenNamed, idKey, num, objectName, properties, str } from './tree.js';

// FBX rotation order enum to three.js Euler order.
const EULER = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ'];

function push(map, key, value) {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(value);
}

function matrixOf(n) {
    const a = arr(n);
    return a.length === 16 ? new Matrix4().fromArray(Array.from(a)) : null;
}

function vec(values, fallback) {
    return values && values.length >= 3 ? new Vector3(values[0], values[1], values[2]) : new Vector3(...fallback);
}

function rotation(values, order) {
    const v = vec(values, [0, 0, 0]);
    return new Matrix4().makeRotationFromEuler(new Euler(MathUtils.degToRad(v.x), MathUtils.degToRad(v.y), MathUtils.degToRad(v.z), order));
}

// FBX local transform:
// T * Roff * Rp * Rpre * R * Rpost^-1 * Rp^-1 * Soff * Sp * S * Sp^-1
function localMatrix(p) {
    const order = EULER[p.get('RotationOrder')?.[0] ?? 0] ?? 'ZYX';
    const active = p.has('RotationActive') ? p.get('RotationActive')[0] !== 0 : true;
    const T = new Matrix4().makeTranslation(vec(p.get('Lcl Translation'), [0, 0, 0]));
    const R = rotation(p.get('Lcl Rotation'), order);
    const S = new Matrix4().makeScale(...vec(p.get('Lcl Scaling'), [1, 1, 1]).toArray());
    const Roff = new Matrix4().makeTranslation(vec(p.get('RotationOffset'), [0, 0, 0]));
    const Rp = new Matrix4().makeTranslation(vec(p.get('RotationPivot'), [0, 0, 0]));
    const Soff = new Matrix4().makeTranslation(vec(p.get('ScalingOffset'), [0, 0, 0]));
    const Sp = new Matrix4().makeTranslation(vec(p.get('ScalingPivot'), [0, 0, 0]));
    const Rpre = active ? rotation(p.get('PreRotation'), 'ZYX') : new Matrix4();
    const Rpost = active ? rotation(p.get('PostRotation'), 'ZYX') : new Matrix4();
    return T.multiply(Roff).multiply(Rp).multiply(Rpre).multiply(R).multiply(Rpost.invert())
        .multiply(Rp.clone().invert()).multiply(Soff).multiply(Sp).multiply(S).multiply(Sp.clone().invert());
}

function geometricMatrix(p) {
    const T = new Matrix4().makeTranslation(vec(p.get('GeometricTranslation'), [0, 0, 0]));
    const R = rotation(p.get('GeometricRotation'), 'ZYX');
    const S = new Matrix4().makeScale(...vec(p.get('GeometricScaling'), [1, 1, 1]).toArray());
    return T.multiply(R).multiply(S);
}

const TYPE_WORDS = [
    [/shoe|sneaker|boot|footwear|slipon|slip_on|trainer|sandal/i, 'Shoes'],
    [/hair|beard|mustache|moustache/i, 'Hair'],
    [/hood|jacket|shirt|tee|tshirt|sweat|top|torso|coat|vest|jersey|crew/i, 'Tops'],
    [/pant|jean|short|trouser|legs|bottom|skirt|jogger|chino/i, 'Bottoms'],
    [/deck|board|griptape|truck|wheel/i, 'Deck'],
    [/hat|cap|beanie|helmet|headwear|bucket/i, 'Hats'],
    [/glove|hand/i, 'Gloves'],
    [/glass|eyewear|goggle|sunnies/i, 'Eyewear'],
    [/sock/i, 'Socks'],
    [/costume|fullbody|outfit|suit/i, 'Full costume'],
];

export function guessCosmeticType(...names) {
    const text = names.join(' ');
    for (const [re, type] of TYPE_WORDS) if (re.test(text)) return type;
    return 'Cosmetic';
}

// Layer element accessor: corner -> item index in the element's data array.
function layerAccessor(elem, dataName, indexName, polyOfCorner, cpOfCorner) {
    if (!elem) return null;
    const mapping = str(child(elem, 'MappingInformationType')?.props[0]) || 'ByPolygonVertex';
    const ref = str(child(elem, 'ReferenceInformationType')?.props[0]) || 'Direct';
    const data = childArr(elem, dataName);
    const index = ref === 'IndexToDirect' || ref === 'Index' ? childArr(elem, indexName) : null;
    if (!data.length) return null;
    const at = corner => {
        let k;
        switch (mapping) {
            case 'ByPolygon': k = polyOfCorner[corner]; break;
            case 'ByVertice': case 'ByVertex': case 'ByControlPoint': k = cpOfCorner[corner]; break;
            case 'AllSame': k = 0; break;
            default: k = corner;
        }
        return index && index.length ? index[k] : k;
    };
    return { at, data, mapping, ref, name: str(child(elem, 'Name')?.props[0]), index: num(elem.props[0]) ?? 0 };
}

function readGeometry(g) {
    const positions = childArr(g, 'Vertices');
    const pvi = childArr(g, 'PolygonVertexIndex');
    const cpCount = Math.floor(positions.length / 3);
    const cornerCount = pvi.length;
    const cpOfCorner = new Int32Array(cornerCount);
    const polyOfCorner = new Int32Array(cornerCount);
    const polyStart = [];
    let poly = 0;
    let start = 0;
    for (let c = 0; c < cornerCount; c++) {
        let v = pvi[c];
        const last = v < 0;
        if (last) v = ~v;
        cpOfCorner[c] = v;
        polyOfCorner[c] = poly;
        if (last) {
            polyStart.push(start);
            start = c + 1;
            poly++;
        }
    }
    if (start < cornerCount) {
        polyStart.push(start);
        for (let c = start; c < cornerCount; c++) polyOfCorner[c] = poly;
        poly++;
    }
    polyStart.push(cornerCount);

    const tris = [];
    for (let p = 0; p < poly; p++) {
        const s = polyStart[p];
        const e = polyStart[p + 1];
        for (let k = s + 1; k + 1 < e; k++) tris.push(s, k, k + 1);
    }

    const layers = {};
    const get = (type, idx = 0) => g.children.filter(c => c.name === type).find(c => num(c.props[0]) === idx) ?? null;
    layers.normal = layerAccessor(get('LayerElementNormal'), 'Normals', 'NormalsIndex', polyOfCorner, cpOfCorner);
    layers.material = layerAccessor(get('LayerElementMaterial'), 'Materials', '', polyOfCorner, cpOfCorner);
    layers.uvs = childrenNamed(g, 'LayerElementUV')
        .sort((a, b) => num(a.props[0]) - num(b.props[0]))
        .map(e => layerAccessor(e, 'UV', 'UVIndex', polyOfCorner, cpOfCorner))
        .filter(Boolean);
    layers.colors = childrenNamed(g, 'LayerElementColor')
        .sort((a, b) => num(a.props[0]) - num(b.props[0]))
        .map(e => layerAccessor(e, 'Colors', 'ColorIndex', polyOfCorner, cpOfCorner))
        .filter(Boolean);

    return { positions, cpCount, cornerCount, cpOfCorner, polyOfCorner, polyCount: poly, tris: Int32Array.from(tris), layers };
}

export function buildScene(doc, fileName = '') {
    const top = name => doc.nodes.find(n => n.name === name);
    const objects = new Map();
    for (const n of top('Objects').children) {
        if (!n.props.length) continue;
        const id = idKey(n.props[0]);
        objects.set(id, { id, node: n, kind: n.name, name: objectName(n.props[1]), sub: str(n.props[2]) });
    }
    const kids = new Map();
    const parents = new Map();
    for (const c of top('Connections')?.children ?? []) {
        if (c.name !== 'C' && c.name !== 'Connect') continue;
        const conn = { type: str(c.props[0]), child: idKey(c.props[1]), parent: idKey(c.props[2]), prop: c.props[3] ? str(c.props[3]) : '' };
        push(kids, conn.parent, conn);
        push(parents, conn.child, conn);
    }
    const childObjs = (id, kind, sub) =>
        (kids.get(id) ?? []).map(c => objects.get(c.child)).filter(o => o && (!kind || o.kind === kind) && (!sub || o.sub === sub));
    const parentObjs = (id, kind) => (parents.get(id) ?? []).map(c => objects.get(c.parent)).filter(o => o && (!kind || o.kind === kind));

    const settings = properties(top('GlobalSettings'));
    const upAxis = settings.get('UpAxis')?.[0] ?? 1;
    const upSign = settings.get('UpAxisSign')?.[0] ?? 1;
    const unitScale = settings.get('UnitScaleFactor')?.[0] ?? 1;

    const models = new Map();
    for (const o of objects.values()) {
        if (o.kind !== 'Model') continue;
        const parent = parentObjs(o.id, 'Model')[0] ?? null;
        models.set(o.id, { ...o, parentId: parent?.id ?? null, props: properties(o.node), global: null });
    }
    const globalOf = id => {
        const m = models.get(id);
        if (!m) return new Matrix4();
        if (!m.global) {
            const local = localMatrix(m.props);
            m.global = m.parentId ? globalOf(m.parentId).clone().multiply(local) : local;
        }
        return m.global;
    };

    const bindPose = new Map();
    for (const o of objects.values()) {
        if (o.kind !== 'Pose') continue;
        const type = o.sub || str(child(o.node, 'Type')?.props[0]);
        if (type !== 'BindPose') continue;
        for (const pn of childrenNamed(o.node, 'PoseNode')) {
            const id = idKey(child(pn, 'Node')?.props[0]);
            const m = matrixOf(child(pn, 'Matrix'));
            if (id && m && !bindPose.has(id)) bindPose.set(id, m);
        }
    }

    const boneBind = new Map();
    const slots = [];
    const warnings = [];
    for (const m of models.values()) {
        if (m.sub !== 'Mesh') continue;
        const geom = childObjs(m.id, 'Geometry').find(g => g.sub === 'Mesh' || g.sub === '');
        if (!geom) continue;
        const data = readGeometry(geom.node);
        if (!data.cpCount || !data.tris.length) continue;

        const materials = childObjs(m.id, 'Material').map(x => ({ id: x.id, name: x.name, node: x.node }));
        const skin = childObjs(geom.id, 'Deformer', 'Skin')[0] ?? null;
        const clusters = skin
            ? childObjs(skin.id, 'Deformer', 'Cluster').map(c => {
                const bone = childObjs(c.id, 'Model')[0] ?? null;
                return {
                    id: c.id,
                    node: c.node,
                    boneId: bone?.id ?? null,
                    boneName: bone?.name ?? c.name,
                    transform: matrixOf(child(c.node, 'Transform')) ?? new Matrix4(),
                    transformLink: matrixOf(child(c.node, 'TransformLink')) ?? new Matrix4(),
                    indexes: childArr(c.node, 'Indexes'),
                    weights: childArr(c.node, 'Weights'),
                };
            })
            : [];
        for (const c of clusters) if (c.boneId && !boneBind.has(c.boneId)) boneBind.set(c.boneId, c.transformLink);

        // Where the mesh sat when it was bound. In FBX data a cluster's
        // Transform is usually stored relative to its bone (TransformLink^-1 *
        // mesh), but some writers store the mesh's global matrix. Pick the
        // reading that agrees across clusters (or with the bind pose).
        let meshGlobal = bindPose.get(m.id) ?? globalOf(m.id);
        if (clusters.length) {
            const stored = clusters.map(c => c.transformLink.clone().multiply(c.transform));
            const direct = clusters.map(c => c.transform);
            const spread = list => list.reduce((s, x) => s + matrixDistance(x, list[0]), 0);
            const ref = bindPose.get(m.id);
            let useStored;
            if (clusters.length > 1 && Math.abs(spread(stored) - spread(direct)) > 1e-6) useStored = spread(stored) < spread(direct);
            else if (ref) useStored = matrixDistance(stored[0], ref) <= matrixDistance(direct[0], ref);
            else useStored = true;
            meshGlobal = useStored ? stored[0] : direct[0];
        }
        const bind = meshGlobal.clone().multiply(geometricMatrix(m.props));
        const normalBind = new Matrix3().getNormalMatrix(bind);

        const cpWorld = new Float32Array(data.cpCount * 3);
        const v = new Vector3();
        for (let i = 0; i < data.cpCount; i++) {
            v.set(data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]).applyMatrix4(bind);
            cpWorld[i * 3] = v.x;
            cpWorld[i * 3 + 1] = v.y;
            cpWorld[i * 3 + 2] = v.z;
        }

        // Skin weights per control point, compressed rows.
        const rows = Array.from({ length: data.cpCount }, () => []);
        clusters.forEach((c, k) => {
            const n = Math.min(c.indexes.length, c.weights.length);
            for (let i = 0; i < n; i++) {
                const cp = c.indexes[i];
                const w = c.weights[i];
                if (cp >= 0 && cp < data.cpCount && w > 0) rows[cp].push(k, w);
            }
        });
        let maxInfluences = 0;
        let unweighted = 0;
        const wStart = new Int32Array(data.cpCount + 1);
        for (let i = 0; i < data.cpCount; i++) {
            wStart[i + 1] = wStart[i] + rows[i].length / 2;
            maxInfluences = Math.max(maxInfluences, rows[i].length / 2);
            if (!rows[i].length) unweighted++;
        }
        const wBone = new Int32Array(wStart[data.cpCount]);
        const wVal = new Float32Array(wStart[data.cpCount]);
        for (let i = 0; i < data.cpCount; i++) {
            for (let j = 0; j < rows[i].length; j += 2) {
                wBone[wStart[i] + j / 2] = rows[i][j];
                wVal[wStart[i] + j / 2] = rows[i][j + 1];
            }
        }
        if (clusters.length && unweighted) warnings.push(`${m.name}: ${unweighted} vertices have no bone weights.`);

        const shapes = [];
        for (const bs of childObjs(geom.id, 'Deformer', 'BlendShape')) {
            for (const ch of childObjs(bs.id, 'Deformer', 'BlendShapeChannel')) {
                for (const sh of childObjs(ch.id, 'Geometry', 'Shape')) {
                    const idx = childArr(sh.node, 'Indexes');
                    const dv = childArr(sh.node, 'Vertices');
                    const dn = childArr(sh.node, 'Normals');
                    const deltas = new Float32Array(data.cpCount * 3);
                    const ndeltas = dn.length ? new Float32Array(data.cpCount * 3) : null;
                    for (let i = 0; i < idx.length; i++) {
                        const cp = idx[i];
                        if (cp < 0 || cp >= data.cpCount) continue;
                        for (let a = 0; a < 3; a++) {
                            deltas[cp * 3 + a] = dv[i * 3 + a] ?? 0;
                            if (ndeltas) ndeltas[cp * 3 + a] = dn[i * 3 + a] ?? 0;
                        }
                    }
                    shapes.push({ id: sh.id, node: sh.node, name: sh.name || ch.name, deltas, ndeltas });
                }
            }
        }

        const lodMatch = /lod[_\s.-]?(\d+)/i.exec(m.name) ?? /lod[_\s.-]?(\d+)/i.exec(geom.name);
        slots.push({
            id: m.id,
            name: m.name,
            modelNode: m.node,
            geomId: geom.id,
            geomNode: geom.node,
            lod: lodMatch ? Number(lodMatch[1]) : 0,
            materials,
            bind,
            normalBind,
            data,
            cpWorld,
            clusters,
            skinned: clusters.length > 0,
            weights: { start: wStart, bone: wBone, value: wVal },
            maxInfluences,
            shapes,
        });
    }

    // Skeleton: every bone a cluster uses, every LimbNode, and their non-mesh
    // ancestors.
    const skeletonIds = new Set(boneBind.keys());
    for (const m of models.values()) if (m.sub === 'LimbNode' || m.sub === 'Root') skeletonIds.add(m.id);
    for (const id of [...skeletonIds]) {
        let p = models.get(id)?.parentId;
        while (p && !skeletonIds.has(p) && models.get(p)?.sub !== 'Mesh') {
            skeletonIds.add(p);
            p = models.get(p)?.parentId;
        }
    }
    const bones = [];
    for (const id of skeletonIds) {
        const m = models.get(id);
        if (!m) continue;
        let parentId = m.parentId;
        while (parentId && !skeletonIds.has(parentId)) parentId = models.get(parentId)?.parentId ?? null;
        bones.push({ id, name: m.name, type: m.sub, parentId, bind: boneBind.get(id) ?? bindPose.get(id) ?? globalOf(id) });
    }

    const type = guessCosmeticType(fileName, ...slots.map(s => s.name), ...slots.flatMap(s => s.materials.map(x => x.name)));
    return { slots, bones, upAxis, upSign, unitScale, type, warnings };
}

function matrixDistance(a, b) {
    let d = 0;
    for (let i = 0; i < 16; i++) d += Math.abs(a.elements[i] - b.elements[i]);
    return d;
}

// Left/right bone pairs give the character's mirror plane.
export function detectMirrorPlane(bones) {
    const byName = new Map(bones.map(b => [b.name, b]));
    const swaps = [
        [/Left/g, 'Right'], [/Right/g, 'Left'], [/left/g, 'right'], [/right/g, 'left'], [/LEFT/g, 'RIGHT'], [/RIGHT/g, 'LEFT'],
        [/(^|[^A-Za-z])L(?=[^A-Za-z]|$)/g, '$1R'], [/(^|[^A-Za-z])R(?=[^A-Za-z]|$)/g, '$1L'],
        [/(^|[^A-Za-z])l(?=[^A-Za-z]|$)/g, '$1r'], [/(^|[^A-Za-z])r(?=[^A-Za-z]|$)/g, '$1l'],
    ];
    const axisSum = [0, 0, 0];
    const mids = [[], [], []];
    const pa = new Vector3();
    const pb = new Vector3();
    let pairs = 0;
    const seen = new Set();
    for (const b of bones) {
        for (const [re, to] of swaps) {
            const other = b.name.replace(re, to);
            if (other === b.name || !byName.has(other)) continue;
            const key = [b.name, other].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            pa.setFromMatrixPosition(b.bind);
            pb.setFromMatrixPosition(byName.get(other).bind);
            const d = pb.clone().sub(pa);
            if (d.length() < 1e-6) continue;
            pairs++;
            for (let a = 0; a < 3; a++) {
                axisSum[a] += Math.abs(d.getComponent(a));
                mids[a].push((pa.getComponent(a) + pb.getComponent(a)) / 2);
            }
        }
    }
    if (!pairs) return { axis: 0, offset: 0, pairs: 0 };
    const axis = axisSum.indexOf(Math.max(...axisSum));
    const list = mids[axis].sort((a, b) => a - b);
    return { axis, offset: list[Math.floor(list.length / 2)], pairs };
}

// Splits a slot into pieces that sit apart (a pair of shoes in one mesh
// becomes two targets): connected triangles, then pieces whose bounds overlap.
export function slotPieces(slot) {
    const { tris, cpOfCorner, cpCount } = slot.data;
    const parent = new Int32Array(cpCount).map((_, i) => i);
    const find = x => {
        while (parent[x] !== x) x = parent[x] = parent[parent[x]];
        return x;
    };
    for (let t = 0; t < tris.length; t += 3) {
        const a = find(cpOfCorner[tris[t]]);
        const b = find(cpOfCorner[tris[t + 1]]);
        const c = find(cpOfCorner[tris[t + 2]]);
        parent[b] = a;
        parent[find(c)] = find(a);
    }
    const boxes = new Map();
    const p = slot.cpWorld;
    for (let t = 0; t < tris.length; t += 3) {
        const cp = cpOfCorner[tris[t]];
        const r = find(cp);
        let box = boxes.get(r);
        if (!box) boxes.set(r, (box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], tris: [] }));
        box.tris.push(t / 3);
        for (let k = 0; k < 3; k++) {
            const q = cpOfCorner[tris[t + k]];
            for (let a = 0; a < 3; a++) {
                box.min[a] = Math.min(box.min[a], p[q * 3 + a]);
                box.max[a] = Math.max(box.max[a], p[q * 3 + a]);
            }
        }
    }
    let list = [...boxes.values()];
    let size = 0;
    for (const b of list) for (let a = 0; a < 3; a++) size = Math.max(size, b.max[a] - b.min[a]);
    const pad = size * 0.02;
    const overlap = (x, y) => [0, 1, 2].every(a => x.min[a] - pad <= y.max[a] && y.min[a] - pad <= x.max[a]);
    let merged = true;
    while (merged) {
        merged = false;
        outer: for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (!overlap(list[i], list[j])) continue;
                const a = list[i];
                const b = list[j];
                for (let k = 0; k < 3; k++) {
                    a.min[k] = Math.min(a.min[k], b.min[k]);
                    a.max[k] = Math.max(a.max[k], b.max[k]);
                }
                a.tris = a.tris.concat(b.tris);
                list.splice(j, 1);
                merged = true;
                break outer;
            }
        }
    }
    // Tiny bits (stray triangles) join the nearest real piece.
    const total = list.reduce((s, b) => s + b.tris.length, 0);
    const major = list.filter(b => b.tris.length >= total * 0.03);
    if (major.length && major.length < list.length) {
        for (const b of list) {
            if (major.includes(b)) continue;
            const c = b.min.map((m, a) => (m + b.max[a]) / 2);
            let best = major[0];
            let bestD = Infinity;
            for (const m of major) {
                const d = m.min.reduce((s, mm, a) => s + ((mm + m.max[a]) / 2 - c[a]) ** 2, 0);
                if (d < bestD) {
                    bestD = d;
                    best = m;
                }
            }
            best.tris = best.tris.concat(b.tris);
            for (let k = 0; k < 3; k++) {
                best.min[k] = Math.min(best.min[k], b.min[k]);
                best.max[k] = Math.max(best.max[k], b.max[k]);
            }
        }
        list = major;
    }
    return list.map(b => ({ min: new Vector3(...b.min), max: new Vector3(...b.max), tris: Int32Array.from(b.tris).sort() }));
}
