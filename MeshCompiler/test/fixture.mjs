// A small skinned FBX built in code: a three-bone leg (Root > Foot > Toe) and
// a box "shoe" skinned to Foot and Toe, with a bind pose and a material.
import { Matrix4 } from 'three';
import { node, P } from '../src/fbx/tree.js';

const id = n => P.i64(n);
const name = (n, cls) => P.str(`${n}\u0000\u0001${cls}`);
const prop = (key, type, label, flags, ...values) =>
    node('P', [P.str(key), P.str(type), P.str(label), P.str(flags), ...values.map(v => (typeof v === 'string' ? P.str(v) : Number.isInteger(v) && type === 'int' ? P.i32(v) : P.f64(v)))]);
const props70 = (...ps) => node('Properties70', [], ps, true);
const arr = (n, type, values) => ({ ...node(n, [type === 'i' ? P.i32s(values) : P.f64s(values)]), array: true });
const val = (n, ...props) => node(n, props, [], false);

// Box from (x0,y0,z0) to (x1,y1,z1) as quads.
export function boxGeometry([x0, y0, z0], [x1, y1, z1]) {
    const v = [
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
    return { positions: v.flat(), faces };
}

// perVertex: normals and UVs stored per control point in float arrays, the
// way engine meshes are often exported.
export function makeSkinnedFbx({ version = 7400, perVertex = false } = {}) {
    const { positions, faces } = boxGeometry([-0.5, 0, -0.2], [0.5, 0.4, 1.8]);
    const pvi = [];
    const normals = [];
    const uvs = [];
    for (const f of faces) {
        f.forEach((v, k) => {
            pvi.push(k === f.length - 1 ? ~v : v);
            normals.push(0, 1, 0);
            uvs.push(positions[v * 3] + 0.5, positions[v * 3 + 2] / 2);
        });
    }
    const boneGlobal = {
        1: new Matrix4(),
        2: new Matrix4().makeTranslation(0, 0.2, 0),
        3: new Matrix4().makeTranslation(0, 0.2, 1.2),
    };
    // Toe owns the front half (z > 0.8), Foot the rest, with a blend at z=1.
    const foot = { idx: [], w: [] };
    const toe = { idx: [], w: [] };
    for (let i = 0; i < positions.length / 3; i++) {
        const z = positions[i * 3 + 2];
        const t = z > 1 ? 1 : 0;
        if (t < 1) {
            foot.idx.push(i);
            foot.w.push(1 - t);
        }
        if (t > 0) {
            toe.idx.push(i);
            toe.w.push(t);
        }
    }
    const meshGlobal = new Matrix4();
    const cluster = (cid, cname, bone, data) =>
        node('Deformer', [id(cid), name(cname, 'SubDeformer'), P.str('Cluster')], [
            val('Version', P.i32(100)),
            val('UserData', P.str(''), P.str('')),
            arr('Indexes', 'i', data.idx),
            arr('Weights', 'd', data.w),
            arr('Transform', 'd', boneGlobal[bone].clone().invert().multiply(meshGlobal).toArray()),
            arr('TransformLink', 'd', boneGlobal[bone].toArray()),
        ]);
    const limb = (mid, mname, t) =>
        node('Model', [id(mid), name(mname, 'Model'), P.str('LimbNode')], [
            val('Version', P.i32(232)),
            props70(prop('Lcl Translation', 'Lcl Translation', '', 'A', ...t)),
        ]);
    const nodes = [
        node('FBXHeaderExtension', [], [val('FBXHeaderVersion', P.i32(1003)), val('FBXVersion', P.i32(version))]),
        node('GlobalSettings', [], [val('Version', P.i32(1000)), props70(prop('UpAxis', 'int', 'Integer', '', 1), prop('UpAxisSign', 'int', 'Integer', '', 1), prop('UnitScaleFactor', 'double', 'Number', '', 1.5))]),
        node('Objects', [], [
            limb(1001, 'Root', [0, 0, 0]),
            limb(1002, 'Foot', [0, 0.2, 0]),
            limb(1003, 'Toe', [0, 0, 1.2]),
            node('Model', [id(2001), name('Shoe', 'Model'), P.str('Mesh')], [val('Version', P.i32(232)), props70()]),
            node('Geometry', [id(3001), name('Shoe', 'Geometry'), P.str('Mesh')], [
                perVertex ? { ...arr('Vertices', 'd', positions), props: [{ t: 'f', v: Float32Array.from(positions) }] } : arr('Vertices', 'd', positions),
                arr('PolygonVertexIndex', 'i', pvi),
                val('GeometryVersion', P.i32(124)),
                perVertex
                    ? node('LayerElementNormal', [P.i32(0)], [val('Version', P.i32(102)), val('Name', P.str('')), val('MappingInformationType', P.str('ByVertice')), val('ReferenceInformationType', P.str('Direct')), { ...arr('Normals', 'd', []), props: [{ t: 'f', v: new Float32Array(24).map((_, i) => (i % 3 === 1 ? 1 : 0)) }] }])
                    : node('LayerElementNormal', [P.i32(0)], [val('Version', P.i32(102)), val('Name', P.str('')), val('MappingInformationType', P.str('ByPolygonVertex')), val('ReferenceInformationType', P.str('Direct')), arr('Normals', 'd', normals)]),
                perVertex
                    ? node('LayerElementUV', [P.i32(0)], [val('Version', P.i32(101)), val('Name', P.str('UVMap')), val('MappingInformationType', P.str('ByVertice')), val('ReferenceInformationType', P.str('Direct')), arr('UV', 'd', new Array(16).fill(0.5))])
                    : node('LayerElementUV', [P.i32(0)], [val('Version', P.i32(101)), val('Name', P.str('UVMap')), val('MappingInformationType', P.str('ByPolygonVertex')), val('ReferenceInformationType', P.str('IndexToDirect')), arr('UV', 'd', uvs), arr('UVIndex', 'i', uvs.map((_, i) => i).filter(i => i % 2 === 0).map(i => i / 2))]),
                node('LayerElementMaterial', [P.i32(0)], [val('Version', P.i32(101)), val('Name', P.str('')), val('MappingInformationType', P.str('AllSame')), val('ReferenceInformationType', P.str('IndexToDirect')), arr('Materials', 'i', [0])]),
                node('Layer', [P.i32(0)], [
                    val('Version', P.i32(100)),
                    node('LayerElement', [], [val('Type', P.str('LayerElementNormal')), val('TypedIndex', P.i32(0))]),
                    node('LayerElement', [], [val('Type', P.str('LayerElementUV')), val('TypedIndex', P.i32(0))]),
                    node('LayerElement', [], [val('Type', P.str('LayerElementMaterial')), val('TypedIndex', P.i32(0))]),
                ]),
            ]),
            node('Material', [id(4001), name('Footwear_mat', 'Material'), P.str('')], [val('Version', P.i32(102)), props70()]),
            node('Deformer', [id(5001), name('Skin', 'Deformer'), P.str('Skin')], [val('Version', P.i32(101))]),
            cluster(5002, 'Foot', 2, foot),
            cluster(5003, 'Toe', 3, toe),
            node('Pose', [id(6001), name('BindPose', 'Pose'), P.str('BindPose')], [
                val('Type', P.str('BindPose')),
                val('Version', P.i32(100)),
                val('NbPoseNodes', P.i32(4)),
                ...[[1001, 1], [1002, 2], [1003, 3]].map(([n, b]) => node('PoseNode', [], [val('Node', id(n)), arr('Matrix', 'd', boneGlobal[b].toArray())])),
                node('PoseNode', [], [val('Node', id(2001)), arr('Matrix', 'd', meshGlobal.toArray())]),
            ]),
        ]),
        node('Connections', [], [
            [1001, 0], [1002, 1001], [1003, 1002], [2001, 0], [3001, 2001], [4001, 2001], [5001, 3001], [5002, 5001], [5003, 5001], [1002, 5002], [1003, 5003],
        ].map(([c, p]) => val('C', P.str('OO'), id(c), id(p)))),
    ];
    return { format: 'binary', version, nodes, footerId: undefined, hasFooter: true, compressed: true };
}

// A new "model": a box of a different shape, as a part ready for compile().
export function boxPart(min, max, matrix = new Matrix4()) {
    const { positions, faces } = boxGeometry(min, max);
    const index = [];
    for (const f of faces) index.push(f[0], f[1], f[2], f[0], f[2], f[3]);
    const normals = new Float32Array(positions.length).fill(0);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    return {
        id: 'p1',
        name: 'Box',
        positions: Float32Array.from(positions),
        normals,
        uvs: [new Float32Array((positions.length / 3) * 2), null],
        index: Uint32Array.from(index),
        triMaterial: new Int32Array(index.length / 3),
        materialNames: ['Leather'],
        matrix,
    };
}
