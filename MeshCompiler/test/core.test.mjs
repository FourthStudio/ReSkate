import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { readFbx, writeFbx } from '../src/fbx/document.js';
import { readAscii, writeAscii } from '../src/fbx/ascii.js';
import { buildScene, detectMirrorPlane, slotPieces } from '../src/fbx/scene.js';
import { autoPlan, compile } from '../src/fbx/compile.js';
import { meanDistance } from '../src/mesh/transfer.js';
import { TriangleGrid } from '../src/mesh/grid.js';
import { autoAlign, mirrorMatrix } from '../src/mesh/align.js';
import { child, childArr, idKey } from '../src/fbx/tree.js';
import { boxPart, makeSkinnedFbx } from './fixture.mjs';

const objectsOf = doc => doc.nodes.find(n => n.name === 'Objects').children;
const byId = (doc, id) => objectsOf(doc).find(n => idKey(n.props[0]) === String(id));

for (const version of [7400, 7500]) {
    test(`binary ${version}: write, read and write again gives the same bytes`, () => {
        const bytes = writeFbx(makeSkinnedFbx({ version }));
        const doc = readFbx(bytes);
        assert.equal(doc.version, version);
        assert.deepEqual(writeFbx(doc), bytes);
    });
}

test('ASCII: read and write keep every value', () => {
    const doc = makeSkinnedFbx();
    doc.format = 'ascii';
    doc.header = '; FBX 7.4.0 project file';
    const text = writeAscii(doc);
    const back = readAscii(text);
    assert.equal(back.version, 7400);
    assert.equal(writeAscii(back), text);
    const scene = buildScene(back);
    assert.equal(scene.slots.length, 1);
    assert.equal(scene.slots[0].clusters.length, 2);
});

test('scene: slot, skin and skeleton are read in bind space', () => {
    const scene = buildScene(readFbx(writeFbx(makeSkinnedFbx())));
    assert.equal(scene.slots.length, 1);
    const slot = scene.slots[0];
    assert.equal(slot.name, 'Shoe');
    assert.equal(slot.data.cpCount, 8);
    assert.equal(slot.data.tris.length / 3, 12);
    assert.deepEqual(slot.clusters.map(c => c.boneName), ['Foot', 'Toe']);
    assert.ok(slot.bind.equals(new Matrix4()), 'mesh bind matrix is identity');
    assert.deepEqual(scene.bones.map(b => b.name).sort(), ['Foot', 'Root', 'Toe']);
    const toe = scene.bones.find(b => b.name === 'Toe');
    assert.deepEqual(new Vector3().setFromMatrixPosition(toe.bind).toArray(), [0, 0.2, 1.2]);
    assert.equal(slot.maxInfluences, 1);
    assert.equal(scene.unitScale, 1.5);
});

test('grid: closest point matches brute force', () => {
    const pos = new Float32Array(300);
    for (let i = 0; i < pos.length; i++) pos[i] = Math.sin(i * 12.9898) * 43758.5453 % 1;
    const tris = Int32Array.from({ length: 99 }, (_, i) => (i * 7) % 100);
    const grid = new TriangleGrid(pos, tris);
    const out = {};
    for (let k = 0; k < 200; k++) {
        const p = [Math.sin(k) * 1.5, Math.cos(k * 1.3) * 1.5, Math.sin(k * 0.7) * 1.5];
        grid.closest(...p, out);
        let best = Infinity;
        const res = {};
        for (let t = 0; t < tris.length / 3; t++) best = Math.min(best, grid.closestOnTri(t, ...p, res));
        assert.ok(Math.abs(out.d2 - best) < 1e-9, `query ${k}: grid ${out.d2} vs brute ${best}`);
    }
});

test('compile: new mesh gets the original bones, the rest is untouched', () => {
    const original = readFbx(writeFbx(makeSkinnedFbx()));
    const scene = buildScene(original);
    // A wider, longer box moved slightly: front half should follow Toe.
    const part = boxPart([-0.6, 0, -0.3], [0.6, 0.5, 2.0]);
    const plan = autoPlan(scene, [part], meanDistance);
    assert.deepEqual(plan.get(scene.slots[0].id), { mode: 'replace', parts: ['p1'] });
    const result = compile(original, scene, [part], plan, {});
    const out = readFbx(result.bytes);

    // Untouched nodes are byte-identical: models, materials, pose, connections.
    for (const n of ['Connections', 'GlobalSettings', 'FBXHeaderExtension']) {
        assert.deepEqual(writeFbx({ ...out, nodes: out.nodes.filter(x => x.name === n) }), writeFbx({ ...original, nodes: original.nodes.filter(x => x.name === n) }));
    }
    for (const id of [1001, 1002, 1003, 2001, 4001, 6001]) assert.deepEqual(byId(out, id), byId(original, id));

    const scene2 = buildScene(out);
    const slot = scene2.slots[0];
    assert.equal(slot.data.cpCount, 8);
    assert.equal(slot.data.tris.length / 3, 12);
    // Every control point is weighted, weights sum to 1.
    const sums = new Float64Array(slot.data.cpCount);
    for (const c of slot.clusters) c.indexes.forEach((cp, i) => (sums[cp] += c.weights[i]));
    for (const s of sums) assert.ok(Math.abs(s - 1) < 1e-6);
    // Front vertices follow Toe, back ones Foot.
    const toe = slot.clusters.find(c => c.boneName === 'Toe');
    for (let i = 0; i < 8; i++) {
        const z = slot.data.positions[i * 3 + 2];
        const w = toe.indexes.includes(i) ? toe.weights[toe.indexes.indexOf(i)] : 0;
        assert.equal(w > 0.5, z > 1, `cp ${i} at z=${z} has toe weight ${w}`);
    }
    // Cluster matrices are the originals.
    for (const cid of [5002, 5003]) {
        assert.deepEqual(Array.from(childArr(byId(out, cid), 'TransformLink')), Array.from(childArr(byId(original, cid), 'TransformLink')));
        assert.deepEqual(Array.from(childArr(byId(out, cid), 'Transform')), Array.from(childArr(byId(original, cid), 'Transform')));
    }
    // Layers are rewritten consistently.
    const g = byId(out, 3001);
    assert.equal(childArr(child(g, 'LayerElementUV'), 'UVIndex').length, 36);
    assert.equal(childArr(child(g, 'LayerElementNormal'), 'Normals').length, 36 * 3);
    assert.equal(result.report[0].bones, 2);
});

test('compile: per-control-point layers and float arrays are kept as the original had them', () => {
    const original = readFbx(writeFbx(makeSkinnedFbx({ perVertex: true })));
    const scene = buildScene(original);
    const part = boxPart([-0.6, 0, -0.3], [0.6, 0.5, 2.0]);
    // Give each face its own normal so the box must split at its edges.
    const faceNormals = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0]];
    const index = [];
    const positions = [];
    const normals = [];
    [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]].forEach((f, k) => {
        const base = positions.length / 3;
        for (const v of f) {
            positions.push(...part.positions.slice(v * 3, v * 3 + 3));
            normals.push(...faceNormals[k]);
        }
        index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    Object.assign(part, { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: [new Float32Array(48), null], index: Uint32Array.from(index), triMaterial: new Int32Array(12) });
    const result = compile(original, scene, [part], autoPlan(scene, [part], meanDistance), {});
    const g = byId(readFbx(result.bytes), 3001);
    const nrm = child(g, 'LayerElementNormal');
    assert.equal(child(nrm, 'MappingInformationType').props[0].v, 'ByVertice');
    assert.equal(child(nrm, 'Normals').props[0].t, 'f');
    assert.equal(child(g, 'Vertices').props[0].t, 'f');
    const cps = child(g, 'Vertices').props[0].v.length / 3;
    assert.equal(cps, 24, 'a box with hard edges needs 24 control points');
    assert.equal(child(nrm, 'Normals').props[0].v.length, cps * 3);
    assert.equal(child(child(g, 'LayerElementUV'), 'MappingInformationType').props[0].v, 'ByVertice');
    // Split copies of a corner share their weights.
    const slot = buildScene(readFbx(result.bytes)).slots[0];
    const weightOf = cp => slot.clusters.map(c => (c.indexes.includes(cp) ? c.weights[c.indexes.indexOf(cp)] : 0)).join(',');
    const byPos = new Map();
    for (let cp = 0; cp < cps; cp++) {
        const key = Array.from(slot.data.positions.slice(cp * 3, cp * 3 + 3)).join(',');
        if (byPos.has(key)) assert.equal(weightOf(cp), byPos.get(key));
        else byPos.set(key, weightOf(cp));
    }
    assert.equal(byPos.size, 8);
});

test('compile: a mirrored part flips its winding so faces still point out', () => {
    const original = readFbx(writeFbx(makeSkinnedFbx()));
    const scene = buildScene(original);
    const m = mirrorMatrix(0, 0);
    const part = boxPart([-0.5, 0, -0.2], [0.5, 0.4, 1.8], m);
    const plain = compile(original, scene, [boxPart([-0.5, 0, -0.2], [0.5, 0.4, 1.8])], autoPlan(scene, [boxPart([-0.5, 0, -0.2], [0.5, 0.4, 1.8])], meanDistance), {});
    const mirrored = compile(original, scene, [part], autoPlan(scene, [part], meanDistance), {});
    const area = res => {
        const s = buildScene(readFbx(res.bytes)).slots[0];
        const p = s.data.positions;
        let vol = 0;
        for (let t = 0; t < s.data.tris.length; t += 3) {
            const [a, b, c] = [0, 1, 2].map(k => new Vector3().fromArray(p, s.data.cpOfCorner[s.data.tris[t + k]] * 3));
            vol += a.dot(b.clone().cross(c));
        }
        return vol;
    };
    assert.ok(Math.sign(area(plain)) === Math.sign(area(mirrored)), 'signed volume keeps its sign');
});

test('compile: "hide" leaves a valid, collapsed mesh that keeps its skin', () => {
    const original = readFbx(writeFbx(makeSkinnedFbx()));
    const scene = buildScene(original);
    const plan = new Map([[scene.slots[0].id, { mode: 'hide', parts: [] }]]);
    const result = compile(original, scene, [], plan, {});
    const slot = buildScene(readFbx(result.bytes)).slots[0];
    assert.equal(slot.data.cpCount, 3);
    assert.equal(slot.data.tris.length, 3);
    const total = slot.clusters.reduce((s, c) => s + c.indexes.length, 0);
    assert.ok(total >= 3, 'every collapsed vertex is weighted');
});

test('compile: an ASCII cosmetic is written back as ASCII', () => {
    const asciiDoc = makeSkinnedFbx();
    asciiDoc.format = 'ascii';
    asciiDoc.header = '; FBX 7.4.0 project file';
    const original = readFbx(new TextEncoder().encode(writeAscii(asciiDoc)));
    assert.equal(original.format, 'ascii');
    const scene = buildScene(original);
    const part = boxPart([-0.6, 0, -0.3], [0.6, 0.5, 2.0]);
    const result = compile(original, scene, [part], autoPlan(scene, [part], meanDistance), {});
    const text = new TextDecoder().decode(result.bytes);
    assert.ok(text.startsWith('; FBX 7.4.0 project file'));
    const back = buildScene(readFbx(result.bytes));
    assert.equal(back.slots[0].clusters.length, 2);
    assert.equal(back.slots[0].data.tris.length / 3, 12);
});

test('auto align finds orientation and size of a rotated, scaled copy', () => {
    const scene = buildScene(readFbx(writeFbx(makeSkinnedFbx())));
    const slot = scene.slots[0];
    const [piece] = slotPieces(slot);
    // The same box, in centimetres-like scale and lying along X.
    const part = boxPart([-0.2 * 50, 0, -0.5 * 50], [1.8 * 50, 0.4 * 50, 0.5 * 50]);
    // Box: x 2.0 long, z 1.0 wide: turn so its long side lands on z.
    const m = autoAlign(part, slot, piece);
    const corners = [];
    for (let i = 0; i < part.positions.length; i += 3) corners.push(new Vector3().fromArray(part.positions, i).applyMatrix4(m));
    const min = corners.reduce((a, b) => a.clone().min(b));
    const max = corners.reduce((a, b) => a.clone().max(b));
    assert.ok(min.distanceTo(new Vector3(-0.5, 0, -0.2)) < 0.02, 'min ' + min.toArray());
    assert.ok(max.distanceTo(new Vector3(0.5, 0.4, 1.8)) < 0.02, 'max ' + max.toArray());
});

test('mirror plane comes from left/right bone names', () => {
    const bones = [
        { name: 'LeftFoot', bind: new Matrix4().makeTranslation(0.1, 0, 0) },
        { name: 'RightFoot', bind: new Matrix4().makeTranslation(-0.1, 0, 0) },
        { name: 'Foot_L', bind: new Matrix4().makeTranslation(0.12, 0.5, 0) },
        { name: 'Foot_R', bind: new Matrix4().makeTranslation(-0.12, 0.5, 0) },
    ];
    const plane = detectMirrorPlane(bones);
    assert.equal(plane.axis, 0);
    assert.ok(Math.abs(plane.offset) < 1e-9);
    assert.equal(plane.pairs, 2);
});

// A shoe pair on a skater rig, exported by Blender 5.2's FBX exporter.
test('Blender FBX: byte-identical round trip, and each new shoe only uses its own leg', async () => {
    const { readFileSync } = await import('node:fs');
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/blender_shoe_pair.fbx', import.meta.url)));
    const original = readFbx(bytes);
    assert.deepEqual(writeFbx(original), bytes);
    const scene = buildScene(original);
    assert.deepEqual(scene.slots.map(s => s.name), ['Own_ShoeSneaker_Test_L', 'Own_ShoeSneaker_Test_R']);
    const plane = detectMirrorPlane(scene.bones);
    assert.equal(plane.axis, 0);
    // A box over the left shoe, and its mirror over the right one.
    const left = { ...boxPart([4, 0, -13], [16, 14, 19]), id: 'L' };
    const right = { ...boxPart([4, 0, -13], [16, 14, 19], mirrorMatrix(plane.axis, plane.offset)), id: 'R' };
    const plan = autoPlan(scene, [left, right], meanDistance);
    assert.deepEqual(plan.get(scene.slots[0].id).parts, ['L']);
    assert.deepEqual(plan.get(scene.slots[1].id).parts, ['R']);
    const out = buildScene(readFbx(compile(original, scene, [left, right], plan, {}).bytes));
    for (const [slot, side] of [[out.slots[0], 'Left'], [out.slots[1], 'Right']]) {
        const used = slot.clusters.filter(c => c.indexes.length).map(c => c.boneName);
        assert.ok(used.length && used.every(n => n.startsWith(side)), `${slot.name} uses ${used}`);
    }
    assert.deepEqual(out.bones.map(b => b.name), scene.bones.map(b => b.name));
});

test('simplify: hits the budget, keeps both materials and drops unused vertices', async () => {
    const { simplifyPart } = await import('../src/mesh/simplify.js');
    // A 100 x 100 grid bent into a bump, left half material 0, right half 1.
    const n = 100;
    const positions = [];
    const normals = [];
    const uv = [];
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
        positions.push(x / n, y / n, Math.sin((x / n) * Math.PI) * Math.sin((y / n) * Math.PI) * 0.3);
        normals.push(0, 0, 1);
        uv.push(x / n, y / n);
    }
    const index = [];
    const triMaterial = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x;
        index.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
        triMaterial.push(x < n / 2 ? 0 : 1, x < n / 2 ? 0 : 1);
    }
    const part = { name: 'grid', positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: [Float32Array.from(uv), null], index: Uint32Array.from(index), triMaterial: Int32Array.from(triMaterial), materialNames: ['A', 'B'], pieces: [{ name: 'grid', vertexStart: 0, vertexCount: (n + 1) ** 2 }] };
    const out = await simplifyPart(part, 2000);
    const tris = out.index.length / 3;
    assert.ok(tris <= 2200 && tris >= 1500, `got ${tris} triangles`);
    assert.deepEqual([...new Set(out.triMaterial)].sort(), [0, 1]);
    const used = new Set(out.index);
    assert.equal(used.size, out.positions.length / 3);
    assert.equal(out.uvs[0].length / 2, out.positions.length / 3);
    assert.equal(out.pieces[0].vertexCount, out.positions.length / 3);
});

test('atlas: rectangles tile the texture without overlap, bigger surfaces get more room', async () => {
    const { atlasLayout, uvTransform } = await import('../src/atlas.js');
    const layout = atlasLayout(new Map([['Body', 40], ['Sole', 30], ['Laces', 5]]));
    const rects = [...layout.values()];
    const total = rects.reduce((s, r) => s + r.w * r.h, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        assert.ok(overlap < 1e-12);
    }
    const area = n => layout.get(n).w * layout.get(n).h;
    assert.ok(area('Body') > area('Sole') && area('Sole') > area('Laces'));
    const t = uvTransform(layout.get('Laces'));
    const r = layout.get('Laces');
    assert.ok(t.ox >= r.x && t.ox + t.sx <= r.x + r.w && t.oy >= r.y && t.oy + t.sy <= r.y + r.h);
});

test('compile: combined materials get their UVs moved into their rectangle', () => {
    const original = readFbx(writeFbx(makeSkinnedFbx()));
    const scene = buildScene(original);
    const part = boxPart([-0.6, 0, -0.3], [0.6, 0.5, 2.0]);
    part.uvs = [new Float32Array(16).fill(1), null]; // every corner at (1, 1)
    const uvTransforms = new Map([['Leather', { ox: 0.25, oy: 0.5, sx: 0.5, sy: 0.25 }]]);
    const result = compile(original, scene, [part], autoPlan(scene, [part], meanDistance), { uvTransforms });
    const uv = childArr(child(byId(readFbx(result.bytes), 3001), 'LayerElementUV'), 'UV');
    assert.deepEqual(Array.from(uv), [0.75, 0.75]);
});
