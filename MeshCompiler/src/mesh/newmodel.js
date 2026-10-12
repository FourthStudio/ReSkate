// Loads any model (FBX, OBJ, GLB/glTF) and bakes it into static triangles:
// the new model only gives shape, normals, UVs and materials; bones come from
// the original cosmetic.
import { BufferAttribute, BufferGeometry, LoadingManager, Matrix3, Vector3, Vector4 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const TEXTURE_SLOTS = [
    ['map', 'basecolor', 'Base colour'],
    ['normalMap', 'normal', 'Normal'],
    ['roughnessMap', 'roughness', 'Roughness'],
    ['metalnessMap', 'metallic', 'Metallic'],
    ['aoMap', 'ao', 'Ambient occlusion'],
    ['emissiveMap', 'emissive', 'Emissive'],
    ['alphaMap', 'opacity', 'Opacity'],
    ['specularMap', 'specular', 'Specular'],
    ['bumpMap', 'height', 'Height'],
];

export const MODEL_EXT = /\.(fbx|obj|glb|gltf)$/i;

export async function loadModel(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    // Embedded textures load in the background; wait for them (briefly).
    let started = false;
    let finished;
    const loaded = new Promise(r => (finished = r));
    const manager = new LoadingManager(() => finished());
    manager.onStart = () => (started = true);
    manager.onError = () => {};
    manager.setURLModifier(url => (url.startsWith('blob:') || url.startsWith('data:') ? url : PLACEHOLDER));

    let root;
    if (ext === 'fbx') {
        root = new FBXLoader(manager).parse(await file.arrayBuffer(), '');
    } else if (ext === 'obj') {
        root = new OBJLoader(manager).parse(await file.text());
    } else if (ext === 'glb' || ext === 'gltf') {
        const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
        const gltf = await new Promise((resolve, reject) => new GLTFLoader(manager).parse(data, '', resolve, reject));
        root = gltf.scene;
    } else {
        throw new Error('Use an FBX, OBJ or GLB model.');
    }
    if (started) await Promise.race([loaded, new Promise(r => setTimeout(r, 5000))]);
    return bake(root, file.name.replace(/\.[^.]+$/, ''));
}

// All meshes become one part with world transforms applied. `pieces` records
// where each source mesh landed so the part can be split later.
export function bake(root, name) {
    root.updateMatrixWorld(true);
    const positions = [];
    const normals = [];
    const uv0 = [];
    const uv1 = [];
    const index = [];
    const triMaterial = [];
    const materialNames = [];
    const textures = [];
    const pieces = [];
    let hasUv0 = false;
    let hasUv1 = false;
    const seenTex = new Set();
    const v = new Vector3();
    const v4 = new Vector4();
    const n = new Vector3();

    root.traverse(o => {
        if (!o.isMesh || !o.geometry?.attributes.position) return;
        const g = o.geometry;
        const pos = g.attributes.position;
        const nor = g.attributes.normal;
        const ta = g.attributes.uv;
        const tb = g.attributes.uv1 ?? g.attributes.uv2;
        const base = positions.length / 3;
        const nMat = new Matrix3().getNormalMatrix(o.matrixWorld);
        const skinned = o.isSkinnedMesh && o.skeleton && g.attributes.skinIndex;
        if (skinned) o.skeleton.update();
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            if (skinned) o.applyBoneTransform(i, v);
            v.applyMatrix4(o.matrixWorld);
            positions.push(v.x, v.y, v.z);
            if (nor) {
                n.fromBufferAttribute(nor, i);
                if (skinned) {
                    v4.set(n.x, n.y, n.z, 0);
                    o.applyBoneTransform(i, v4);
                    n.set(v4.x, v4.y, v4.z);
                }
                n.applyMatrix3(nMat).normalize();
                normals.push(n.x, n.y, n.z);
            } else normals.push(0, 0, 0);
            uv0.push(ta ? ta.getX(i) : 0, ta ? ta.getY(i) : 0);
            uv1.push(tb ? tb.getX(i) : ta ? ta.getX(i) : 0, tb ? tb.getY(i) : ta ? ta.getY(i) : 0);
        }
        if (ta) hasUv0 = true;
        if (tb) hasUv1 = true;

        const mats = [].concat(o.material ?? []);
        const matIndex = mats.map(m => {
            const label = m?.name || o.name || 'Material';
            let k = materialNames.indexOf(label);
            if (k < 0) {
                k = materialNames.length;
                materialNames.push(label);
            }
            for (const [key, type, slotLabel] of TEXTURE_SLOTS) {
                const tex = m?.[key];
                const img = tex?.image;
                if (!img || seenTex.has(tex) || !(img.width > 1)) continue;
                seenTex.add(tex);
                textures.push({ name: `${label} · ${slotLabel}`, type, material: label, image: img });
            }
            return k;
        });
        if (!matIndex.length) {
            let k = materialNames.indexOf('Material');
            if (k < 0) {
                k = materialNames.length;
                materialNames.push('Material');
            }
            matIndex.push(k);
        }
        const idx = g.index ? Array.from(g.index.array) : Array.from({ length: pos.count }, (_, i) => i);
        const flip = o.matrixWorld.determinant() < 0;
        const groups = g.groups.length ? g.groups : [{ start: 0, count: idx.length, materialIndex: 0 }];
        for (const grp of groups) {
            const end = Math.min(grp.start + grp.count, idx.length);
            for (let t = grp.start; t + 2 < end; t += 3) {
                if (flip) index.push(base + idx[t], base + idx[t + 2], base + idx[t + 1]);
                else index.push(base + idx[t], base + idx[t + 1], base + idx[t + 2]);
                triMaterial.push(matIndex[grp.materialIndex ?? 0] ?? matIndex[0]);
            }
        }
        pieces.push({ name: o.name || `Mesh ${pieces.length + 1}`, vertexStart: base, vertexCount: pos.count });
    });
    if (!index.length) throw new Error('This model has no triangles.');

    const part = {
        name,
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        uvs: [Float32Array.from(uv0), hasUv1 ? Float32Array.from(uv1) : null],
        index: Uint32Array.from(index),
        triMaterial: Int32Array.from(triMaterial),
        materialNames,
        pieces,
        generatedUv: false,
    };
    if (normals.some((x, i) => i % 3 === 0 && x === 0 && normals[i + 1] === 0 && normals[i + 2] === 0)) fillNormals(part);
    if (!hasUv0) {
        boxUv(part);
        part.generatedUv = true;
    }
    return { part: weld(part), textures };
}

// Loaders often give every triangle its own three vertices. Share vertices
// that match in position, normal and UVs so the mesh is connected again
// (needed to simplify it, and much lighter to compile). Seams stay split.
export function weld(part) {
    const n = part.positions.length / 3;
    const keys = new Map();
    const remap = new Uint32Array(n);
    const keep = [];
    const q = x => Math.round(x * 1e5);
    const [ua, ub] = part.uvs;
    for (let i = 0; i < n; i++) {
        const p = part.positions;
        const nn = part.normals;
        let key = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}|${q(nn[i * 3])},${q(nn[i * 3 + 1])},${q(nn[i * 3 + 2])}|${q(ua[i * 2])},${q(ua[i * 2 + 1])}`;
        if (ub) key += `|${q(ub[i * 2])},${q(ub[i * 2 + 1])}`;
        let at = keys.get(key);
        if (at === undefined) {
            at = keep.length;
            keys.set(key, at);
            keep.push(i);
        }
        remap[i] = at;
    }
    if (keep.length === n) return part;
    const take = (src, size) => {
        if (!src) return null;
        const dst = new Float32Array(keep.length * size);
        keep.forEach((i, k) => dst.set(src.subarray(i * size, i * size + size), k * size));
        return dst;
    };
    // Source pieces were contiguous; welding keeps first-seen order, so they
    // still are.
    const pieces = part.pieces.map(pc => {
        const first = remap[pc.vertexStart];
        let last = first;
        for (let v = pc.vertexStart; v < pc.vertexStart + pc.vertexCount; v++) last = Math.max(last, remap[v]);
        return { ...pc, vertexStart: first, vertexCount: last - first + 1 };
    });
    return {
        ...part,
        positions: take(part.positions, 3),
        normals: take(part.normals, 3),
        uvs: [take(ua, 2), take(ub, 2)],
        index: Uint32Array.from(part.index, i => remap[i]),
        pieces,
    };
}

function fillNormals(part) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(part.positions, 3));
    g.setIndex(new BufferAttribute(part.index, 1));
    g.computeVertexNormals();
    const computed = g.attributes.normal.array;
    for (let i = 0; i < part.normals.length; i += 3) {
        if (part.normals[i] === 0 && part.normals[i + 1] === 0 && part.normals[i + 2] === 0) part.normals.set(computed.subarray(i, i + 3), i);
    }
    g.dispose();
}

// Box projection for models without UVs.
function boxUv(part) {
    const p = part.positions;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) {
        min[i % 3] = Math.min(min[i % 3], p[i]);
        max[i % 3] = Math.max(max[i % 3], p[i]);
    }
    const size = Math.max(...max.map((m, a) => m - min[a]), 1e-9);
    const uv = part.uvs[0];
    for (let i = 0; i < p.length / 3; i++) {
        const nx = Math.abs(part.normals[i * 3]), ny = Math.abs(part.normals[i * 3 + 1]), nz = Math.abs(part.normals[i * 3 + 2]);
        const [a, b] = nx >= ny && nx >= nz ? [2, 1] : ny >= nz ? [0, 2] : [0, 1];
        uv[i * 2] = (p[i * 3 + a] - min[a]) / size;
        uv[i * 2 + 1] = (p[i * 3 + b] - min[b]) / size;
    }
}

// A copy of one source mesh of a part (a vertex range), as its own part.
export function extractPiece(part, piece) {
    const { vertexStart: vs, vertexCount: vc } = piece;
    const index = [];
    const triMaterial = [];
    for (let t = 0; t < part.index.length / 3; t++) {
        const a = part.index[t * 3];
        if (a < vs || a >= vs + vc) continue;
        index.push(a - vs, part.index[t * 3 + 1] - vs, part.index[t * 3 + 2] - vs);
        triMaterial.push(part.triMaterial[t]);
    }
    return {
        ...part,
        name: piece.name,
        positions: part.positions.slice(vs * 3, (vs + vc) * 3),
        normals: part.normals.slice(vs * 3, (vs + vc) * 3),
        uvs: part.uvs.map(u => (u ? u.slice(vs * 2, (vs + vc) * 2) : null)),
        index: Uint32Array.from(index),
        triMaterial: Int32Array.from(triMaterial),
        pieces: [{ name: piece.name, vertexStart: 0, vertexCount: vc }],
    };
}

// Re-centres a part on its bounding box; returns the centre that was removed.
export function centre(part) {
    const p = part.positions;
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < p.length; i += 3) {
        v3.set(p[i], p[i + 1], p[i + 2]);
        min.min(v3);
        max.max(v3);
    }
    const c = min.clone().add(max).multiplyScalar(0.5);
    for (let i = 0; i < p.length; i += 3) {
        p[i] -= c.x;
        p[i + 1] -= c.y;
        p[i + 2] -= c.z;
    }
    return c;
}
const v3 = new Vector3();
