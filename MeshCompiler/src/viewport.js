// The 3D view: original cosmetic, new parts, compiled result and skeleton.
// Everything lives under `world`, which is in FBX world space (a Z-up file is
// turned upright for display only).
import {
    Bone, Box3, BoxHelper, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute,
    GridHelper, Group, HemisphereLight, LineBasicMaterial, LineSegments, MathUtils, Matrix4, Mesh, MeshStandardMaterial,
    PerspectiveCamera, PMREMGenerator, Points, PointsMaterial, Raycaster, Scene, Skeleton, SkinnedMesh, SRGBColorSpace,
    Vector2, Vector3, WebGLRenderer, ACESFilmicToneMapping,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export class Viewport {
    constructor(container) {
        this.container = container;
        this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.outputColorSpace = SRGBColorSpace;
        this.renderer.toneMapping = ACESFilmicToneMapping;
        container.prepend(this.renderer.domElement);

        this.scene = new Scene();
        this.scene.background = new Color('#06090d');
        const pmrem = new PMREMGenerator(this.renderer);
        const room = new RoomEnvironment();
        this.scene.environment = pmrem.fromScene(room, 0.04).texture;
        room.dispose?.();
        pmrem.dispose();
        this.scene.add(new HemisphereLight(0xffffff, 0x334455, 1.2));
        const sun = new DirectionalLight(0xffffff, 1.6);
        sun.position.set(3, 5, 4);
        this.scene.add(sun);

        this.grid = new GridHelper(10, 20, 0x1d4a66, 0x13222d);
        this.grid.material.transparent = true;
        this.grid.material.opacity = 0.8;
        this.scene.add(this.grid);

        this.camera = new PerspectiveCamera(40, 1, 0.01, 1000);
        this.camera.position.set(2, 1.5, 2.5);
        this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbit.enableDamping = true;

        this.world = new Group();
        this.scene.add(this.world);
        this.originalGroup = new Group();
        this.partsGroup = new Group();
        this.compiledGroup = new Group();
        this.bonesGroup = new Group();
        this.world.add(this.originalGroup, this.partsGroup, this.compiledGroup, this.bonesGroup);

        this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
        this.gizmoHelper = this.gizmo.getHelper();
        this.scene.add(this.gizmoHelper);
        this.gizmo.addEventListener('dragging-changed', e => (this.orbit.enabled = !e.value));
        this.selectionBox = new BoxHelper(undefined, 0x0091ff);
        this.selectionBox.visible = false;
        this.scene.add(this.selectionBox);

        this.raycaster = new Raycaster();
        this.skeleton = null;
        this.boneObjects = new Map();
        this.pose = { boneId: null, angle: 0, axis: 'x', animate: false };
        this.clock = 0;

        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();
        this.renderer.setAnimationLoop(t => this.frame(t));
    }

    resize() {
        const w = this.container.clientWidth || 1;
        const h = this.container.clientHeight || 1;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    frame(t) {
        if (this.pose.boneId && this.pose.animate) this.applyPose(Math.sin(t / 450) * (this.pose.angle || 35));
        this.orbit.update();
        if (this.selectionBox.visible) this.selectionBox.update();
        this.renderer.render(this.scene, this.camera);
    }

    setUpAxis(axis, sign) {
        this.world.rotation.set(0, 0, 0);
        if (axis === 2) this.world.rotation.x = (-Math.PI / 2) * sign;
        else if (axis === 0) this.world.rotation.z = (Math.PI / 2) * sign;
        else if (sign < 0) this.world.rotation.x = Math.PI;
        this.world.updateMatrixWorld(true);
    }

    fit(objects) {
        const box = new Box3();
        for (const o of objects ?? [this.originalGroup, this.partsGroup, this.compiledGroup]) {
            if (o.visible === false) continue;
            o.updateMatrixWorld(true);
            box.expandByObject(o);
        }
        if (box.isEmpty()) return;
        const c = box.getCenter(new Vector3());
        const size = box.getSize(new Vector3());
        const r = Math.max(size.x, size.y, size.z, 0.01);
        const dist = (r / (2 * Math.tan(MathUtils.degToRad(this.camera.fov / 2)))) * Math.max(1, 1 / this.camera.aspect) * 1.5;
        const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
        if (dir.lengthSq() < 0.5) dir.set(1, 0.6, 1).normalize();
        this.camera.near = r / 500;
        this.camera.far = r * 500;
        this.camera.position.copy(c).addScaledVector(dir, dist);
        this.camera.updateProjectionMatrix();
        this.orbit.target.copy(c);
        this.orbit.update();
        this.grid.position.set(c.x, box.min.y - r * 0.002, c.z);
        this.grid.scale.setScalar(r / 3);
    }

    // ---- original cosmetic ----------------------------------------------

    showOriginal(scene, materials) {
        clear(this.originalGroup);
        clear(this.bonesGroup);
        this.boneObjects.clear();
        this.skeleton = null;
        this.buildSkeleton(scene);
        this.originalMeshes = new Map();
        for (const slot of scene.slots) {
            const geo = slotGeometry(slot);
            const mats = slot.materials.length ? slot.materials.map(m => materials.get(m.name)) : [materials.get('')];
            let mesh;
            if (slot.skinned && this.skeleton) {
                addSkin(geo, slot.data.cpOfCorner, slot.weights, clusterToBone(slot, this.skeletonIndex), slot.data.tris);
                mesh = new SkinnedMesh(geo, mats);
            } else {
                mesh = new Mesh(geo, mats);
            }
            mesh.name = slot.name;
            mesh.userData.slotId = slot.id;
            mesh.frustumCulled = false;
            this.originalGroup.add(mesh);
            bindAtRest(mesh, this.skeleton, this.restPose, this.bonesRoot);
            this.originalMeshes.set(slot.id, mesh);
        }
    }

    buildSkeleton(scene) {
        if (!scene.bones.length) return;
        const byId = new Map(scene.bones.map(b => [b.id, b]));
        const bones = scene.bones.map(b => {
            const bone = new Bone();
            bone.name = b.name;
            bone.userData.id = b.id;
            this.boneObjects.set(b.id, bone);
            return bone;
        });
        const roots = new Group();
        scene.bones.forEach((b, i) => {
            const parent = b.parentId && byId.has(b.parentId) ? this.boneObjects.get(b.parentId) : null;
            const local = parent ? byId.get(b.parentId).bind.clone().invert().multiply(b.bind) : b.bind.clone();
            local.decompose(bones[i].position, bones[i].quaternion, bones[i].scale);
            (parent ?? roots).add(bones[i]);
        });
        this.bonesRoot = roots;
        this.world.add(roots);
        roots.updateMatrixWorld(true);
        this.skeleton = new Skeleton(bones);
        this.skeletonIndex = new Map(scene.bones.map((b, i) => [b.id, i]));
        this.restPose = bones.map(b => b.quaternion.clone());

        // Lines from each bone to its parent, kept in sync every frame.
        const lineGeo = new BufferGeometry();
        const pairs = scene.bones.filter(b => b.parentId && byId.has(b.parentId));
        lineGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(pairs.length * 6), 3));
        const lines = new LineSegments(lineGeo, new LineBasicMaterial({ color: 0x29a8ff, depthTest: false, transparent: true, opacity: 0.9 }));
        const jointGeo = new BufferGeometry();
        jointGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(bones.length * 3), 3));
        const joints = new Points(jointGeo, new PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false, depthTest: false }));
        lines.renderOrder = joints.renderOrder = 10;
        lines.frustumCulled = joints.frustumCulled = false;
        const inv = new Matrix4();
        const p = new Vector3();
        const update = () => {
            inv.copy(this.world.matrixWorld).invert();
            const lp = lineGeo.attributes.position;
            pairs.forEach((b, i) => {
                p.setFromMatrixPosition(this.boneObjects.get(b.id).matrixWorld).applyMatrix4(inv);
                lp.setXYZ(i * 2, p.x, p.y, p.z);
                p.setFromMatrixPosition(this.boneObjects.get(b.parentId).matrixWorld).applyMatrix4(inv);
                lp.setXYZ(i * 2 + 1, p.x, p.y, p.z);
            });
            lp.needsUpdate = true;
            const jp = jointGeo.attributes.position;
            bones.forEach((b, i) => {
                p.setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv);
                jp.setXYZ(i, p.x, p.y, p.z);
            });
            jp.needsUpdate = true;
        };
        lines.onBeforeRender = update;
        this.bonesGroup.add(lines, joints);
    }

    applyPose(angle) {
        if (!this.skeleton) return;
        this.skeleton.bones.forEach((b, i) => b.quaternion.copy(this.restPose[i]));
        const bone = this.boneObjects.get(this.pose.boneId);
        if (bone && angle) {
            const axis = new Vector3(this.pose.axis === 'x' ? 1 : 0, this.pose.axis === 'y' ? 1 : 0, this.pose.axis === 'z' ? 1 : 0);
            bone.rotateOnAxis(axis, MathUtils.degToRad(angle));
        }
        this.bonesRoot?.updateMatrixWorld(true);
    }

    setPose(pose) {
        Object.assign(this.pose, pose);
        if (!this.pose.animate) this.applyPose(this.pose.angle);
    }

    // ---- new parts --------------------------------------------------------

    partGeometry(part) {
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(part.positions, 3));
        geo.setAttribute('normal', new BufferAttribute(part.normals, 3));
        geo.setAttribute('uv', new BufferAttribute(part.uvs[0], 2));
        geo.setIndex(new BufferAttribute(part.index, 1));
        // Consecutive triangles with the same material form a group.
        let start = 0;
        for (let t = 1; t <= part.triMaterial.length; t++) {
            if (t === part.triMaterial.length || part.triMaterial[t] !== part.triMaterial[start]) {
                geo.addGroup(start * 3, (t - start) * 3, part.triMaterial[start]);
                start = t;
            }
        }
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        return geo;
    }

    addPart(part, materials) {
        const geo = this.partGeometry(part);
        const mesh = new Mesh(geo, part.materialNames.map(n => materials(n)));
        mesh.name = part.name;
        this.partsGroup.add(mesh);
        return mesh;
    }

    select(object) {
        this.selected = object ?? null;
        if (object) {
            this.gizmo.attach(object);
            this.selectionBox.setFromObject(object);
            this.selectionBox.visible = true;
        } else {
            this.gizmo.detach();
            this.selectionBox.visible = false;
        }
    }

    pick(event, objects) {
        const r = this.renderer.domElement.getBoundingClientRect();
        const ndc = new Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const hit = this.raycaster.intersectObjects(objects, false)[0];
        return hit?.object ?? null;
    }

    // ---- compiled result --------------------------------------------------

    showCompiled(scene, previews, materials, weightColours) {
        clear(this.compiledGroup);
        this.compiledMeshes = new Map();
        for (const pv of previews) {
            const slot = scene.slots.find(s => s.id === pv.slotId);
            if (!slot || pv.mode === 'hide') continue;
            const geo = compiledGeometry(slot, pv.mesh);
            const mats = slot.materials.length ? slot.materials.map(m => materials.get(m.name)) : [materials.get('')];
            let mesh;
            if (pv.weights && this.skeleton) {
                addSkin(geo, null, pv.weights, clusterToBone(slot, this.skeletonIndex), pv.mesh.tris);
                mesh = new SkinnedMesh(geo, mats);
            } else {
                mesh = new Mesh(geo, mats);
            }
            mesh.userData.weightColours = pv.weights ? weightColoursFor(pv.mesh.tris, pv.weights, slot, weightColours) : null;
            mesh.frustumCulled = false;
            this.compiledGroup.add(mesh);
            bindAtRest(mesh, this.skeleton, this.restPose, this.bonesRoot);
            this.compiledMeshes.set(slot.id, mesh);
        }
    }
}

// Geometry is in FBX world space at bind time, so bind with the bones at rest
// and the mesh's own world matrix (which carries the display up-axis turn).
function bindAtRest(mesh, skeleton, rest, root) {
    if (!mesh.isSkinnedMesh) return;
    const posed = skeleton.bones.map(b => b.quaternion.clone());
    skeleton.bones.forEach((b, i) => b.quaternion.copy(rest[i]));
    root.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    mesh.bind(skeleton, mesh.matrixWorld.clone());
    skeleton.bones.forEach((b, i) => b.quaternion.copy(posed[i]));
    root.updateMatrixWorld(true);
}

function clear(group) {
    for (const c of [...group.children]) {
        group.remove(c);
        c.traverse(o => o.geometry?.dispose());
    }
}

function clusterToBone(slot, skeletonIndex) {
    return slot.clusters.map(c => skeletonIndex?.get(c.boneId) ?? 0);
}

// Per-corner display geometry of an original slot, in world space.
function slotGeometry(slot) {
    const { tris, cpOfCorner, layers } = slot.data;
    const n = tris.length;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const v = new Vector3();
    for (let i = 0; i < n; i++) {
        const corner = tris[i];
        const cp = cpOfCorner[corner];
        pos.set(slot.cpWorld.subarray(cp * 3, cp * 3 + 3), i * 3);
        if (layers.normal) {
            const k = layers.normal.at(corner) * 3;
            v.set(layers.normal.data[k], layers.normal.data[k + 1], layers.normal.data[k + 2]).applyMatrix3(slot.normalBind).normalize();
            nor.set([v.x, v.y, v.z], i * 3);
        }
        if (layers.uvs[0]) {
            const k = layers.uvs[0].at(corner) * 2;
            uv[i * 2] = layers.uvs[0].data[k];
            uv[i * 2 + 1] = layers.uvs[0].data[k + 1];
        }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('uv', new BufferAttribute(uv, 2));
    if (layers.normal) geo.setAttribute('normal', new BufferAttribute(nor, 3));
    else geo.computeVertexNormals();
    addMaterialGroups(geo, n / 3, t => (layers.material ? layers.material.data[layers.material.at(tris[t * 3])] ?? 0 : 0));
    return geo;
}

function compiledGeometry(slot, mesh) {
    const n = mesh.tris.length;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const v = new Vector3();
    for (let i = 0; i < n; i++) {
        const cp = mesh.tris[i];
        pos.set(mesh.cpWorld.subarray(cp * 3, cp * 3 + 3), i * 3);
        v.fromArray(mesh.normals, i * 3).applyMatrix3(slot.normalBind).normalize();
        nor.set([v.x, v.y, v.z], i * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nor, 3));
    geo.setAttribute('uv', new BufferAttribute(Float32Array.from(mesh.uvs[0]), 2));
    addMaterialGroups(geo, n / 3, t => mesh.triMat[t] ?? 0);
    return geo;
}

function addMaterialGroups(geo, triCount, matOf) {
    let start = 0;
    for (let t = 1; t <= triCount; t++) {
        if (t === triCount || matOf(t) !== matOf(start)) {
            geo.addGroup(start * 3, (t - start) * 3, matOf(start));
            start = t;
        }
    }
}

// Top four influences per corner as skinIndex / skinWeight.
function addSkin(geo, cpOfCorner, weights, boneOf, tris) {
    const n = tris.length;
    const idx = new Uint16Array(n * 4);
    const wts = new Float32Array(n * 4);
    const { start, bone, value } = weights;
    for (let i = 0; i < n; i++) {
        const cp = cpOfCorner ? cpOfCorner[tris[i]] : tris[i];
        const row = [];
        for (let j = start[cp]; j < start[cp + 1]; j++) row.push([boneOf[bone[j]], value[j]]);
        row.sort((a, b) => b[1] - a[1]);
        const top = row.slice(0, 4);
        const sum = top.reduce((s, x) => s + x[1], 0) || 1;
        top.forEach(([b, w], k) => {
            idx[i * 4 + k] = b;
            wts[i * 4 + k] = w / sum;
        });
        if (!top.length) wts[i * 4] = 0;
    }
    geo.setAttribute('skinIndex', new BufferAttribute(idx, 4));
    geo.setAttribute('skinWeight', new BufferAttribute(wts, 4));
}

// Colours for "show weights": each bone has a colour, blended by weight.
export function weightColoursFor(tris, weights, slot, colourOfBone) {
    const n = tris.length;
    const col = new Float32Array(n * 3);
    const { start, bone, value } = weights;
    for (let i = 0; i < n; i++) {
        const cp = tris[i];
        for (let j = start[cp]; j < start[cp + 1]; j++) {
            const c = colourOfBone(slot.clusters[bone[j]]?.boneId);
            col[i * 3] += c.r * value[j];
            col[i * 3 + 1] += c.g * value[j];
            col[i * 3 + 2] += c.b * value[j];
        }
    }
    return col;
}

export function originalWeightColours(slot, colourOfBone) {
    const { tris, cpOfCorner } = slot.data;
    const mapped = new Int32Array(tris.length);
    for (let i = 0; i < tris.length; i++) mapped[i] = cpOfCorner[tris[i]];
    const { start, bone, value } = slot.weights;
    const col = new Float32Array(tris.length * 3);
    for (let i = 0; i < mapped.length; i++) {
        const cp = mapped[i];
        let sum = 0;
        for (let j = start[cp]; j < start[cp + 1]; j++) sum += value[j];
        for (let j = start[cp]; j < start[cp + 1]; j++) {
            const c = colourOfBone(slot.clusters[bone[j]]?.boneId);
            const w = value[j] / (sum || 1);
            col[i * 3] += c.r * w;
            col[i * 3 + 1] += c.g * w;
            col[i * 3 + 2] += c.b * w;
        }
    }
    return col;
}

export function makeMaterial(name) {
    const m = new MeshStandardMaterial({ name, color: 0xd9dadb, roughness: 0.75, metalness: 0, side: DoubleSide });
    return m;
}
