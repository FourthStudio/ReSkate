import { CanvasTexture, Color, Euler, MathUtils, Matrix4, MeshLambertMaterial, NoColorSpace, Quaternion, SRGBColorSpace, Vector3, BufferAttribute } from 'three';
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { readFbx } from './fbx/document.js';
import { buildScene, detectMirrorPlane, slotPieces } from './fbx/scene.js';
import { autoPlan, compile } from './fbx/compile.js';
import { meanDistance } from './mesh/transfer.js';
import { centre, extractPiece, loadModel, MODEL_EXT } from './mesh/newmodel.js';
import { simplifyPart } from './mesh/simplify.js';
import { atlasLayout, drawAtlas, flipGreen, materialAreas, uvTransform } from './atlas.js';
import { autoAlign, fitToPiece, mirrorMatrix } from './mesh/align.js';
import { makeMaterial, originalWeightColours, Viewport } from './viewport.js';
import * as tex from './textures.js';

const $ = id => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
};
const fmt = (n, d = 3) => (Number.isFinite(n) ? Number(n.toFixed(d)).toString() : '');
const STEPS = ['import', 'model', 'textures', 'compile'];
const AXES = ['X', 'Y', 'Z'];

// ---- state --------------------------------------------------------------

const SETTINGS_KEY = 'reskate-mesh-compiler-settings';
const defaults = { maxInfluences: 0, smooth: 0, mirrorAxis: 'auto', mirrorOffset: '', unassigned: 'keep', ghost: 45 };
let saved = {};
try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
} catch {
    saved = {};
}

const state = {
    step: 'import',
    page: 'compiler',
    folder: null, // { entries: [{file, path}], fbx: [...], images: [...] }
    original: null, // { entry, name, doc, scene, targets, mirror }
    textures: [], // original texture files
    modelTextures: [], // textures that came with the new model
    parts: [],
    selected: null,
    targetId: null,
    plan: null,
    planManual: false,
    materialMap: new Map(),
    compiled: null,
    dirty: true,
    settings: { ...defaults, ...saved },
    filter: '',
    textureFilter: 'all',
    collapsed: new Set(['bones']),
    undo: [],
    pose: { boneId: null, angle: 30, axis: 'x', animate: false },
    combine: true,
};
let dataSeq = 0;
let partSeq = 0;
let texSeq = 0;

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch {
        /* private mode */
    }
}

// ---- viewport -----------------------------------------------------------

const vp = new Viewport($('viewport'));
const weightMaterial = new MeshLambertMaterial({ vertexColors: true });
const originalMaterials = new Map();
const partMaterials = new Map();
const compiledMaterials = new Map();
const boneColours = new Map();

function boneColour(id) {
    if (!boneColours.has(id)) {
        const i = boneColours.size;
        boneColours.set(id, new Color().setHSL((i * 0.618034) % 1, 0.85, 0.5));
    }
    return boneColours.get(id);
}

function materialFor(map, name) {
    if (!map.has(name)) map.set(name, makeMaterial(name));
    return map.get(name);
}

vp.gizmo.addEventListener('mouseDown', () => pushUndo());
vp.gizmo.addEventListener('objectChange', () => {
    markDirty();
    renderTransform();
});

let downAt = null;
vp.renderer.domElement.addEventListener('pointerdown', e => (downAt = [e.clientX, e.clientY]));
vp.renderer.domElement.addEventListener('pointerup', e => {
    if (state.step !== 'model' || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || vp.gizmo.dragging) return;
    const visible = state.parts.filter(p => p.object.visible && vp.partsGroup.visible).map(p => p.object);
    const hit = vp.pick(e, visible);
    if (hit) selectPart(state.parts.find(p => p.object === hit));
    else selectPart(null);
});

// ---- messages -------------------------------------------------------------

let toastTimer = 0;
function say(text, kind = '') {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'bad' ? 9000 : 4500);
    $('statusLeft').textContent = text;
}

function fail(err) {
    console.error(err);
    say(err?.message || String(err), 'bad');
}

async function busy(text, fn) {
    say(text);
    document.body.style.cursor = 'progress';
    await new Promise(r => setTimeout(r, 30));
    try {
        return await fn();
    } catch (e) {
        fail(e);
        return undefined;
    } finally {
        document.body.style.cursor = '';
    }
}

// ---- import: original cosmetic -------------------------------------------

function entriesFromInput(input) {
    return [...input.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
}

async function entriesFromDrop(dt) {
    const roots = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!roots.length) return [...dt.files].map(file => ({ file, path: file.name }));
    const out = [];
    const walk = async (entry, prefix) => {
        if (entry.isFile) {
            const file = await new Promise((res, rej) => entry.file(res, rej));
            out.push({ file, path: prefix + file.name });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            for (;;) {
                const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                if (!batch.length) break;
                for (const e of batch) await walk(e, prefix + entry.name + '/');
            }
        }
    };
    for (const e of roots) await walk(e, '');
    return out;
}

// Paths relative to the export folder itself.
function relative(entries) {
    const first = entries[0]?.path.split('/') ?? [];
    const shared = first.length > 1 && entries.every(e => e.path.split('/')[0] === first[0]) ? first[0] + '/' : '';
    return { root: shared.replace(/\/$/, ''), entries: entries.map(e => ({ ...e, rel: e.path.slice(shared.length) })) };
}

async function importOriginal(rawEntries) {
    const { root, entries } = relative(rawEntries);
    const fbx = entries.filter(e => /\.fbx$/i.test(e.file.name));
    if (!fbx.length) throw new Error('There is no .fbx in that folder. Export the cosmetic from ReSkate Studio first.');
    const images = entries.filter(e => tex.IMAGE_EXT.test(e.file.name));
    state.folder = { root, entries, fbx, images };
    // Prefer the highest-detail file: no LOD number, or LOD0, then the largest.
    const lodOf = e => Number(/lod[_\s.-]?(\d+)/i.exec(e.file.name)?.[1] ?? 0);
    const main = [...fbx].sort((a, b) => lodOf(a) - lodOf(b) || b.file.size - a.file.size)[0];
    await loadOriginal(main);
    await loadTextures(images);
    refresh();
    say(`Loaded ${main.file.name}: ${state.original.scene.slots.length} mesh(es), ${state.original.scene.bones.length} bones, ${images.length} texture(s).`);
}

async function loadOriginal(entry) {
    const doc = readFbx(await entry.file.arrayBuffer());
    const scene = buildScene(doc, entry.file.name);
    if (!scene.slots.length) throw new Error('This FBX has no meshes to replace.');
    const targets = [];
    for (const slot of [...scene.slots].sort((a, b) => a.lod - b.lod)) {
        const pieces = slotPieces(slot);
        pieces.forEach((piece, i) => {
            targets.push({ id: `${slot.id}#${i}`, slot, piece, label: pieceLabel(slot, piece, pieces.length > 1 ? i + 1 : 0) });
        });
    }
    const name = entry.file.name.replace(/\.fbx$/i, '');
    state.original = { entry, name, doc, scene, targets, mirror: mirrorPlane(scene, targets) };
    state.targetId = targets[0]?.id ?? null;
    state.plan = null;
    state.planManual = false;
    state.compiled = null;
    boneColours.clear();
    scene.bones.forEach(b => boneColour(b.id));
    if (!$('outputName').value || $('outputName').dataset.auto === '1') {
        $('outputName').value = name;
        $('outputName').dataset.auto = '1';
    }
    for (const m of originalMaterials.values()) m.dispose();
    originalMaterials.clear();
    vp.setUpAxis(scene.upAxis, scene.upSign);
    const mats = new Map();
    for (const slot of scene.slots) for (const m of slot.materials) mats.set(m.name, materialFor(originalMaterials, m.name));
    mats.set('', materialFor(originalMaterials, ''));
    vp.showOriginal(scene, mats);
    vp.showCompiled(scene, [], compiledMats(), boneColour);
    const pose = scene.bones.find(b => /foot|ankle/i.test(b.name)) ?? scene.bones.find(b => b.parentId);
    state.pose.boneId = pose?.id ?? null;
    // Parts kept from an earlier cosmetic go back through auto placement.
    for (const p of state.parts) p.object.visible = true;
    $('empty').hidden = true;
    applyVisibility();
    vp.fit([vp.originalGroup]);
    markDirty();
    refresh();
}

function pieceLabel(slot, piece, n) {
    if (!slot.clusters.length) return n ? `${slot.name} · part ${n}` : slot.name;
    const totals = new Float64Array(slot.clusters.length);
    const { tris, cpOfCorner } = slot.data;
    const { start, bone, value } = slot.weights;
    for (const t of piece.tris) {
        const cp = cpOfCorner[tris[t * 3]];
        for (let j = start[cp]; j < start[cp + 1]; j++) totals[bone[j]] += value[j];
    }
    let best = 0;
    for (let k = 1; k < totals.length; k++) if (totals[k] > totals[best]) best = k;
    const boneName = slot.clusters[best]?.boneName;
    return n ? `${slot.name} · ${boneName ?? 'part ' + n}` : slot.name;
}

function mirrorPlane(scene, targets) {
    const s = state.settings;
    let plane = detectMirrorPlane(scene.bones);
    let source = plane.pairs ? `${plane.pairs} left/right bone pairs` : '';
    if (!plane.pairs) {
        const lod0 = targets.filter(t => t.slot.lod === targets[0]?.slot.lod).sort((a, b) => b.piece.tris.length - a.piece.tris.length);
        if (lod0.length >= 2) {
            const a = lod0[0].piece.min.clone().add(lod0[0].piece.max).multiplyScalar(0.5);
            const b = lod0[1].piece.min.clone().add(lod0[1].piece.max).multiplyScalar(0.5);
            const d = b.clone().sub(a);
            const axis = [0, 1, 2].reduce((m, i) => (Math.abs(d.getComponent(i)) > Math.abs(d.getComponent(m)) ? i : m), 0);
            plane = { axis, offset: (a.getComponent(axis) + b.getComponent(axis)) / 2, pairs: 0 };
            source = 'the two halves of the cosmetic';
        } else {
            plane = { axis: 0, offset: 0, pairs: 0 };
            source = 'default';
        }
    }
    if (s.mirrorAxis !== 'auto') {
        plane = { ...plane, axis: AXES.indexOf(s.mirrorAxis) };
        source = 'settings';
    }
    if (s.mirrorOffset !== '' && Number.isFinite(Number(s.mirrorOffset))) {
        plane = { ...plane, offset: Number(s.mirrorOffset) };
        source = 'settings';
    }
    return { ...plane, source };
}

async function loadTextures(entries) {
    state.textures = [];
    const names = [...new Set(state.original.scene.slots.flatMap(s => s.materials.map(m => m.name)))];
    for (const e of entries) {
        const t = {
            id: 't' + ++texSeq,
            entry: e,
            name: e.file.name,
            type: tex.textureType(e.file.name),
            material: tex.matchMaterial(e.file.name, names),
            canvas: null,
            thumb: null,
            stats: { average: '#808080', detail: 1 },
            choice: { mode: 'keep' },
        };
        try {
            t.canvas = await tex.decodeImage(e.file);
            if (t.canvas.unsupported) t.note = `${t.canvas.unsupported} DDS: no preview, kept as is`;
            t.stats = tex.imageStats(t.canvas);
        } catch (err) {
            t.note = 'Could not read this image: ' + err.message;
        }
        t.thumb = tex.thumbnail(t.canvas);
        state.textures.push(t);
    }
    refreshPreviewTextures();
}

// ---- new model ------------------------------------------------------------

async function importModel(entry) {
    if (!MODEL_EXT.test(entry.file.name)) throw new Error('Use an FBX, OBJ or GLB model.');
    const { part: full, textures } = await loadModel(entry.file);
    centre(full);
    full.uid = ++dataSeq;
    const names = full.materialNames;
    for (const t of textures) {
        const canvas = document.createElement('canvas');
        canvas.width = t.image.width;
        canvas.height = t.image.height;
        canvas.getContext('2d').drawImage(t.image, 0, 0);
        state.modelTextures.push({ id: 'm' + ++texSeq, name: t.name, type: t.type, material: t.material ?? (names.length === 1 ? names[0] : null), canvas, thumb: tex.thumbnail(canvas) });
    }
    for (const name of names) if (!state.materialMap.has(name)) state.materialMap.set(name, defaultOriginalMaterial());
    // Models made for film or renders are far heavier than a game cosmetic:
    // bring them down to a sensible budget straight away.
    const fullTris = full.index.length / 3;
    const budget = recommendedBudget();
    let data = full;
    if (fullTris > Math.max(30000, budget * 2.5)) data = await detailed(full, budget);
    const p = addPart(data, full.name);
    if (state.original) autoPlace(p, currentTarget());
    selectPart(p);
    autoAssignModelTextures();
    vp.fit();
    const tris = data.index.length / 3;
    const parts = [`${entry.file.name}: ${fullTris.toLocaleString()} triangles`];
    if (tris < fullTris) parts.push(`simplified to ${tris.toLocaleString()} for the game (change it under Detail)`);
    if (state.original) parts.push('placed on ' + (currentTarget()?.label ?? 'the cosmetic'));
    if (full.generatedUv) parts.push('it had no UVs, so simple box UVs were made');
    say(parts.join(', ') + '.');
}

// Triangles per piece: twice the original's, between 8k and 20k.
function recommendedBudget() {
    const o = state.original;
    if (!o) return 20000;
    const lod = Math.min(...o.targets.map(t => t.slot.lod));
    const pieces = o.targets.filter(t => t.slot.lod === lod);
    const tris = pieces.reduce((n, t) => n + t.piece.tris.length, 0) / Math.max(pieces.length, 1);
    return Math.min(20000, Math.max(8000, Math.round((tris * 2) / 1000) * 1000));
}

async function detailed(full, target) {
    if (!target || target >= full.index.length / 3) return full;
    const data = await simplifyPart(full, target);
    data.full = full;
    data.uid = ++dataSeq;
    data.detail = target;
    return data;
}

// Re-simplifies (from full detail) every part that shares p's model.
async function setDetail(p, target) {
    const old = p.data;
    const full = old.full ?? old;
    const data = await detailed(full, target);
    for (const q of state.parts.filter(x => x.data === old)) {
        q.data = data;
        q.object.geometry.dispose();
        q.object.geometry = vp.partGeometry(data);
    }
    markDirty();
    refresh();
    say(`${p.name}: ${(data.index.length / 3).toLocaleString()} triangles.`);
}

function defaultOriginalMaterial() {
    const scene = state.original?.scene;
    if (!scene) return '';
    const counts = new Map();
    for (const s of scene.slots) for (const m of s.materials) counts.set(m.name, (counts.get(m.name) ?? 0) + s.data.tris.length);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function addPart(data, name, matrix) {
    const object = vp.addPart(data, n => materialFor(partMaterials, n));
    if (matrix) matrix.decompose(object.position, object.quaternion, object.scale);
    data.uid ??= ++dataSeq;
    const p = { id: 'p' + ++partSeq, name, data, object };
    object.userData.partId = p.id;
    state.parts.push(p);
    refreshPreviewTextures();
    markDirty();
    return p;
}

function removePart(p) {
    if (!p) return;
    pushUndo();
    vp.partsGroup.remove(p.object);
    if (!state.parts.some(o => o !== p && o.data === p.data)) p.object.geometry.dispose();
    state.parts = state.parts.filter(o => o !== p);
    if (state.selected === p) selectPart(null);
    markDirty();
    refresh();
}

function selectPart(p) {
    state.selected = p ?? null;
    vp.select(state.step === 'model' ? p?.object ?? null : null);
    refreshSide();
    renderPanel();
}

function currentTarget() {
    return state.original?.targets.find(t => t.id === state.targetId) ?? state.original?.targets[0] ?? null;
}

function setMatrix(p, m) {
    m.decompose(p.object.position, p.object.quaternion, p.object.scale);
    p.object.updateMatrixWorld(true);
    markDirty();
    renderTransform();
}

function autoPlace(p, target) {
    if (!p || !target) return;
    const mirrored = p.object.matrix.determinant() < 0;
    p.object.updateMatrix();
    const { upAxis, upSign } = state.original.scene;
    const up = new Vector3().setComponent(upAxis, upSign || 1);
    setMatrix(p, autoAlign(p.data, target.slot, target.piece, mirrored, up));
}

function pushUndo() {
    state.undo.push(state.parts.map(p => ({ p, m: p.object.matrix.clone() })));
    if (state.undo.length > 60) state.undo.shift();
}

function undo() {
    const snap = state.undo.pop();
    if (!snap) return say('Nothing to undo.');
    for (const { p, m } of snap) if (state.parts.includes(p)) m.decompose(p.object.position, p.object.quaternion, p.object.scale);
    markDirty();
    renderTransform();
    say('Undone.');
}

function duplicate(p, mirror) {
    if (!p) return say('Select a new part first.', 'warn');
    pushUndo();
    p.object.updateMatrix();
    const m = p.object.matrix.clone();
    if (mirror) {
        const plane = state.original?.mirror ?? { axis: 0, offset: 0 };
        m.premultiply(mirrorMatrix(plane.axis, plane.offset));
    }
    const base = p.name.replace(/ \((mirrored|copy)( \d+)?\)$/, '');
    const copy = addPart(p.data, `${base} (${mirror ? 'mirrored' : 'copy'})`, m);
    if (!mirror) {
        const size = new Vector3();
        p.object.geometry.boundingBox.getSize(size);
        copy.object.position.x += size.x * Math.abs(p.object.scale.x) * 1.2;
    }
    selectPart(copy);
    say(mirror ? `Mirrored across ${AXES[state.original?.mirror.axis ?? 0]} = ${fmt(state.original?.mirror.offset ?? 0)}.` : 'Duplicated.');
}

function splitPart(p) {
    if (!p || p.data.pieces.length < 2) return say('This part is a single mesh.', 'warn');
    pushUndo();
    p.object.updateMatrix();
    const made = [];
    for (const piece of p.data.pieces) {
        const data = extractPiece(p.data, piece);
        const c = centre(data);
        const m = p.object.matrix.clone().multiply(new Matrix4().makeTranslation(c.x, c.y, c.z));
        made.push(addPart(data, piece.name, m));
    }
    removePart(p);
    selectPart(made[0]);
    say(`Split into ${made.length} parts.`);
}

// ---- textures ---------------------------------------------------------------

const canvasTextures = new WeakMap();
function textureOf(canvas, colour) {
    if (!canvas || canvas.unsupported) return null;
    let t = canvasTextures.get(canvas);
    if (!t) {
        t = new CanvasTexture(canvas);
        t.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
        t.anisotropy = 8;
        canvasTextures.set(canvas, t);
    }
    return t;
}

// The image a texture slot will hold in the export.
function outputCanvas(t) {
    const base = baseOutput(t);
    if (!t.flipGreen || t.type.key !== 'normal' || !base || base.unsupported) return base;
    if (t._flipSrc !== base) {
        t._flipSrc = base;
        t._flipped = flipGreen(base);
    }
    return t._flipped;
}

function baseOutput(t) {
    const c = t.choice;
    const w = t.canvas?.width || 1024;
    const hgt = t.canvas?.height || 1024;
    if (c.mode === 'image' && c.canvas) return c.canvas;
    if (c.mode === 'model') return state.modelTextures.find(m => m.id === c.id)?.canvas ?? t.canvas;
    if (c.mode === 'flat') {
        if (!c.canvas || c.canvas.dataset.colour !== c.colour || c.canvas.width !== w || c.canvas.height !== hgt) {
            c.canvas = tex.flatCanvas(w, hgt, c.colour);
            c.canvas.dataset.colour = c.colour;
        }
        return c.canvas;
    }
    if (c.mode === 'atlas') {
        const group = atlasGroups().get(t.material ?? defaultOriginalMaterial());
        if (!group) return t.canvas;
        const entries = group.names.map(name => {
            const src = modelTexture(name, c.type);
            return { rect: group.layout.get(name), source: src?.canvas ?? null, id: src?.id ?? '', fill: tex.neutralColour(c.type, '#9a9a9a') };
        });
        const key = JSON.stringify([w, hgt, entries.map(e => [e.rect, e.id, e.fill])]);
        if (c.key !== key) {
            c.key = key;
            c.canvas = drawAtlas(w, hgt, entries);
        }
        return c.canvas;
    }
    return t.canvas;
}

function modelTexture(material, type) {
    return state.modelTextures.find(x => x.type === type && x.material === material) ?? null;
}

// New-model materials that share one original material, and where each goes
// in its texture. Only groups of two or more need combining.
let atlasMemo = { key: '', groups: new Map() };
function atlasGroups() {
    if (!state.combine) return new Map();
    const datas = [...new Set(state.parts.map(p => p.data))];
    const key = datas.map(d => d.uid).join(',') + '|' + JSON.stringify([...state.materialMap]);
    if (atlasMemo.key === key) return atlasMemo.groups;
    const areas = new Map();
    for (const d of datas) materialAreas(d, 1, areas);
    const byOriginal = new Map();
    for (const [name, area] of areas) {
        const orig = state.materialMap.get(name) ?? defaultOriginalMaterial();
        if (!byOriginal.has(orig)) byOriginal.set(orig, new Map());
        byOriginal.get(orig).set(name, area);
    }
    const groups = new Map();
    for (const [orig, list] of byOriginal) if (list.size >= 2) groups.set(orig, { names: [...list.keys()], layout: atlasLayout(list) });
    atlasMemo = { key, groups };
    return groups;
}

function uvTransforms() {
    const out = new Map();
    for (const g of atlasGroups().values()) for (const [name, rect] of g.layout) out.set(name, uvTransform(rect));
    return out;
}

function texturesFor(materialName, type, output) {
    const list = state.textures.filter(t => t.type.key === type && (!t.material || t.material === materialName || !materialName));
    const t = list.find(x => x.material === materialName) ?? list[0];
    if (!t) return null;
    return output ? outputCanvas(t) : t.canvas;
}

function compiledMats() {
    const map = new Map();
    const names = new Set(state.original?.scene.slots.flatMap(s => s.materials.map(m => m.name)) ?? []);
    names.add('');
    for (const n of names) map.set(n, materialFor(compiledMaterials, n));
    return map;
}

function refreshPreviewTextures() {
    const set = (m, map, normal) => {
        const a = textureOf(map, true);
        const b = textureOf(normal, false);
        if (m.map !== a || m.normalMap !== b) {
            m.map = a;
            m.normalMap = b;
            m.color.set(a ? 0xffffff : 0xd9dadb);
            m.needsUpdate = true;
        }
    };
    for (const [name, m] of originalMaterials) set(m, texturesFor(name, 'basecolor', false), texturesFor(name, 'normal', false));
    for (const [name, m] of compiledMaterials) set(m, texturesFor(name, 'basecolor', true), texturesFor(name, 'normal', true));
    // New parts keep their own UVs, so they show their own textures; an image
    // or flat colour put in the cosmetic's slot is shown instead.
    const single = new Set(state.parts.flatMap(p => p.data.materialNames)).size === 1;
    for (const [name, m] of partMaterials) {
        const orig = state.materialMap.get(name) ?? '';
        const pick = type => {
            const t = state.textures.find(x => x.type.key === type && (x.material === orig || !x.material) && (x.choice.mode === 'image' || x.choice.mode === 'flat'));
            if (t) return outputCanvas(t);
            const own = modelTexture(name, type) ?? (single ? state.modelTextures.find(x => x.type === type) : null);
            return own?.canvas ?? null;
        };
        set(m, pick('basecolor'), pick('normal'));
    }
}

function autoAssignModelTextures() {
    let n = 0;
    const groups = atlasGroups();
    const newNames = [...new Set(state.parts.flatMap(p => p.data.materialNames))];
    for (const t of state.textures) {
        if (t.choice.mode !== 'keep' || ['pattern', 'graphic', 'mask', 'other'].includes(t.type.key)) continue;
        const orig = t.material ?? defaultOriginalMaterial();
        const group = groups.get(orig);
        if (group && group.names.some(name => modelTexture(name, t.type.key))) {
            t.choice = { mode: 'atlas', type: t.type.key };
            n++;
            continue;
        }
        const mapped = newNames.filter(name => (state.materialMap.get(name) ?? orig) === orig);
        const m = mapped.map(name => modelTexture(name, t.type.key)).find(Boolean)
            ?? (newNames.length <= 1 ? state.modelTextures.find(x => x.type === t.type.key) : null);
        if (m) {
            t.choice = { mode: 'model', id: m.id };
            n++;
        }
    }
    if (n) refreshPreviewTextures();
    return n;
}

async function importModelTextures(entries) {
    const images = entries.filter(e => tex.IMAGE_EXT.test(e.file.name));
    if (!images.length) throw new Error('No images there.');
    for (const e of images) {
        try {
            const canvas = await tex.decodeImage(e.file);
            if (canvas.unsupported) continue;
            const names = [...new Set(state.parts.flatMap(p => p.data.materialNames))];
            state.modelTextures.push({ id: 'm' + ++texSeq, name: e.file.name, type: tex.textureType(e.file.name).key, material: tex.matchMaterial(e.file.name, names), canvas, thumb: tex.thumbnail(canvas) });
        } catch {
            /* skipped */
        }
    }
    const n = autoAssignModelTextures();
    refreshPreviewTextures();
    refresh();
    say(`${images.length} texture(s) loaded for the new model, ${n} matched to the cosmetic's texture slots.`);
}

function neutralise() {
    let n = 0;
    for (const t of state.textures) {
        if (t.choice.mode !== 'keep' || t.stats.detail < 0.02) continue;
        t.choice = { mode: 'flat', colour: tex.neutralColour(t.type.key, t.stats.average) };
        n++;
    }
    refreshPreviewTextures();
    refresh();
    say(n ? `${n} texture(s) set to a flat colour so the old layout doesn't show on the new model.` : 'Nothing to change: every texture is already replaced or flat.');
}

// ---- compile & export --------------------------------------------------------

function markDirty() {
    state.dirty = true;
    $('compileTop').disabled = !canCompile();
    renderStatus();
}

function canCompile() {
    return !!state.original && state.parts.length > 0;
}

function partInputs() {
    return state.parts.map(p => {
        p.object.updateMatrix();
        const d = p.data;
        return { id: p.id, name: p.name, positions: d.positions, normals: d.normals, uvs: d.uvs, index: d.index, triMaterial: d.triMaterial, materialNames: d.materialNames, matrix: p.object.matrix.clone() };
    });
}

function ensurePlan() {
    if (!state.original) return;
    const inputs = partInputs();
    const ids = new Set(inputs.map(p => p.id));
    if (state.plan && state.planManual) {
        for (const e of state.plan.values()) e.parts = e.parts.filter(id => ids.has(id));
        const placed = new Set([...state.plan.values()].flatMap(e => e.parts));
        const fresh = inputs.filter(p => !placed.has(p.id));
        if (!fresh.length) return;
        const extra = autoPlan(state.original.scene, fresh, meanDistance);
        for (const [slotId, e] of extra) {
            if (!e.parts.length) continue;
            const cur = state.plan.get(slotId);
            cur.parts.push(...e.parts);
            if (cur.mode !== 'hide') cur.mode = 'replace';
        }
        return;
    }
    state.plan = autoPlan(state.original.scene, inputs, meanDistance);
    for (const e of state.plan.values()) if (!e.parts.length) e.mode = state.settings.unassigned;
}

function runCompile() {
    if (!canCompile()) {
        say(state.original ? 'Import a new model first (step 2).' : 'Import a cosmetic first (step 1).', 'warn');
        return null;
    }
    ensurePlan();
    const t0 = performance.now();
    let result;
    try {
        result = compile(state.original.doc, state.original.scene, partInputs(), state.plan, {
            maxInfluences: Number(state.settings.maxInfluences) || 0,
            smooth: Number(state.settings.smooth) || 0,
            materialMap: state.materialMap,
            uvTransforms: uvTransforms(),
        });
    } catch (e) {
        fail(e);
        return null;
    }
    state.compiled = result;
    state.dirty = false;
    vp.showCompiled(state.original.scene, result.previews, compiledMats(), boneColour);
    refreshPreviewTextures();
    $('showCompiled').checked = true;
    $('showOriginal').checked = false;
    $('showParts').checked = false;
    applyVisibility();
    applyWeights();
    const ms = Math.round(performance.now() - t0);
    const replaced = result.report.filter(r => r.mode === 'replace').length;
    say(`Compiled in ${ms} ms: ${replaced} mesh(es) rebuilt on the original bones.` + (result.warnings.length ? ' ' + result.warnings[0] : ''), result.warnings.length ? 'warn' : '');
    document.querySelector('[data-step=compile]').classList.add('done');
    refresh();
    return result;
}

function ensureCompiled() {
    if (state.compiled && !state.dirty) return state.compiled;
    return runCompile();
}

function outputBase() {
    const raw = $('outputName').value.trim() || state.original?.name || 'cosmetic';
    return raw.replace(/[\\/:*?"<>|]+/g, '_');
}

function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
    }, 2000);
}

function exportFbx() {
    const result = ensureCompiled();
    if (!result) return;
    download(new Blob([result.bytes], { type: 'application/octet-stream' }), outputBase() + '.fbx');
    say(`Saved ${outputBase()}.fbx (${(result.bytes.length / 1024).toFixed(0)} KB).`);
}

async function exportZip() {
    const result = ensureCompiled();
    if (!result) return;
    await busy('Packing the folder…', async () => {
        const base = outputBase();
        const files = {};
        const fbxRel = state.original.entry.rel ?? state.original.entry.file.name;
        const dir = fbxRel.includes('/') ? fbxRel.slice(0, fbxRel.lastIndexOf('/') + 1) : '';
        files[`${base}/${dir}${base}.fbx`] = result.bytes;
        let changed = 0;
        for (const t of state.textures) {
            const rel = t.entry.rel ?? t.name;
            if ((t.choice.mode === 'keep' && !t.flipGreen) || !t.canvas || t.canvas.unsupported) {
                files[`${base}/${rel}`] = new Uint8Array(await t.entry.file.arrayBuffer());
            } else {
                const out = tex.resized(outputCanvas(t), t.canvas.width, t.canvas.height);
                files[`${base}/${rel}`] = new Uint8Array(await (await tex.encodeImage(out, t.name)).arrayBuffer());
                changed++;
            }
        }
        const zip = zipSync(files, { level: 6 });
        download(new Blob([zip], { type: 'application/zip' }), base + '.zip');
        say(`Saved ${base}.zip: the FBX and ${state.textures.length} texture(s), ${changed} replaced.`);
    });
}

// ---- rendering: step tabs, side list, panel -----------------------------------

function setStep(step) {
    state.step = step;
    document.querySelectorAll('[data-step]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.step === step)));
    if (step === 'compile') ensurePlan();
    if (step === 'model' && state.parts.length) {
        $('showParts').checked = true;
        $('showOriginal').checked = true;
        applyVisibility();
    }
    if (step === 'textures' || step === 'import') {
        $('showOriginal').checked = true;
        applyVisibility();
    }
    vp.gizmo.enabled = step === 'model';
    vp.select(step === 'model' ? state.selected?.object : null);
    applyGhost();
    refresh();
}

function refresh() {
    document.querySelectorAll('.tabs button').forEach(b => {
        const s = b.dataset.step;
        const done = (s === 'import' && state.original) || (s === 'model' && state.parts.length) || (s === 'textures' && state.textures.some(t => t.choice.mode !== 'keep')) || (s === 'compile' && state.compiled && !state.dirty);
        b.classList.toggle('done', !!done);
    });
    refreshSide();
    renderPanel();
    renderStage();
    renderStatus();
}

function renderStage() {
    const o = state.original;
    $('stageTitle').textContent = o ? o.entry.file.name : 'No cosmetic loaded';
    $('stageSub').textContent = o ? o.scene.type : 'Import a folder exported from ReSkate Studio to begin';
    const stats = [];
    if (o) {
        const verts = o.scene.slots.reduce((s, x) => s + x.data.cpCount, 0);
        const tris = o.scene.slots.reduce((s, x) => s + x.data.tris.length / 3, 0);
        stats.push(`${verts.toLocaleString()} vertices / ${tris.toLocaleString()} triangles`);
    }
    if (state.compiled && !state.dirty) {
        const r = state.compiled.report.filter(x => x.mode === 'replace');
        const tris = r.reduce((s, x) => s + x.triangles, 0);
        if (r.length) stats.push(`compiled ${tris.toLocaleString()} triangles`);
    }
    $('vpStats').textContent = stats.join('  ·  ');
    $('gizmoModes').hidden = state.step !== 'model';
    document.querySelectorAll('#gizmoModes .btn').forEach(b => b.classList.toggle('on', vp.gizmo.mode === b.dataset.mode));
    const next = $('nextStep');
    const i = STEPS.indexOf(state.step);
    if (state.step === 'compile') {
        next.textContent = 'Export folder (.zip)';
        next.disabled = !canCompile();
    } else {
        next.textContent = ['Next: new model', 'Next: textures', 'Next: compile'][i];
        next.disabled = state.step === 'import' ? !state.original : false;
    }
    $('exportFbxTop').disabled = !canCompile();
    $('compileTop').disabled = !canCompile();
    $('hintLine').textContent = hint();
}

function hint() {
    if (!state.original) return 'Import the folder you exported from ReSkate Studio (the FBX and its textures).';
    switch (state.step) {
        case 'import': return 'Check the meshes and bones, then go to the next step to bring in your new model.';
        case 'model':
            if (!state.parts.length) return 'Import your new model. It is placed and sized on the selected target for you.';
            return 'Drag the handles or type values to fine-tune. For a pair (shoes, gloves), use Duplicate & mirror for the other side.';
        case 'textures': return 'Replace the textures your new model needs. Textures painted for the old mesh will not line up on a new model.';
        default:
            if (!state.compiled || state.dirty) return 'Press Compile to give the new model the original bones, then check it with the bend test.';
            return 'Export the folder and load the FBX (and any replaced textures) into ReSkate Studio for this cosmetic.';
    }
}

function renderStatus() {
    const o = state.original;
    const bits = [];
    if (o) {
        bits.push(`${o.scene.slots.length} mesh${o.scene.slots.length === 1 ? '' : 'es'}`, `${o.scene.bones.length} bones`, `${state.textures.length} textures`);
        bits.push(`${state.parts.length} new part${state.parts.length === 1 ? '' : 's'}`);
        bits.push(state.compiled && !state.dirty ? 'compiled' : 'not compiled');
    }
    $('statusRight').textContent = o ? bits.join(' / ') : 'NO COSMETIC LOADED';
}

function sideRow({ label, tag, sel, onClick, indent, img, dot, eye, title }) {
    const row = h('div', { class: 'row' + (sel ? ' sel' : '') + (indent ? ' indent' : ''), role: 'option', 'aria-selected': sel ? 'true' : 'false', tabindex: '0', title: title ?? label, onclick: onClick, onkeydown: e => (e.key === 'Enter' || e.key === ' ') && onClick?.() });
    if (img) row.append(h('img', { src: img, alt: '' }));
    if (dot) row.append(h('span', { class: 'dot ' + dot }));
    row.append(h('span', { class: 'name' }, label));
    if (tag) row.append(h('span', { class: 'tag' }, `[${tag}]`));
    if (eye) row.append(eye);
    return row;
}

function groupHeader(key, text) {
    const open = !state.collapsed.has(key);
    return h('div', {
        class: 'group-title',
        style: 'cursor:pointer',
        onclick: () => {
            if (open) state.collapsed.add(key);
            else state.collapsed.delete(key);
            refreshSide();
        },
    }, `${open ? '▾' : '▸'} ${text}`);
}

function refreshSide() {
    const list = $('sideList');
    const tools = $('sideTools');
    list.replaceChildren();
    tools.replaceChildren();
    const filter = h('input', { class: 'input', placeholder: 'Search', value: state.filter, 'aria-label': 'Search list' });
    filter.addEventListener('input', () => {
        state.filter = filter.value;
        const caret = filter.selectionStart;
        refreshSide();
        const again = $('sideTools').querySelector('input');
        again.focus();
        again.setSelectionRange(caret, caret);
    });
    tools.append(filter);
    const q = state.filter.toLowerCase();
    const match = s => !q || s.toLowerCase().includes(q);
    let count = '';
    const o = state.original;

    if (state.step === 'import') {
        if (!state.folder) {
            list.append(h('div', { class: 'group-title' }, 'Nothing imported yet'));
        } else {
            list.append(groupHeader('models', `Models (${state.folder.fbx.length})`));
            if (!state.collapsed.has('models')) for (const e of state.folder.fbx.filter(e => match(e.rel))) {
                list.append(sideRow({ label: e.rel, tag: 'FBX', sel: o?.entry === e, onClick: () => busy('Reading ' + e.file.name + '…', async () => { await loadOriginal(e); refreshPreviewTextures(); say('Loaded ' + e.file.name + '.'); }) }));
            }
            if (o) {
                list.append(groupHeader('meshes', `Meshes (${o.scene.slots.length})`));
                if (!state.collapsed.has('meshes')) for (const s of o.scene.slots.filter(s => match(s.name))) list.append(sideRow({ label: s.name, tag: s.lod ? 'LOD' + s.lod : 'Mesh' }));
                list.append(groupHeader('bones', `Bones (${o.scene.bones.length})`));
                if (!state.collapsed.has('bones')) {
                    const depth = new Map();
                    const byId = new Map(o.scene.bones.map(b => [b.id, b]));
                    const d = b => {
                        if (!depth.has(b.id)) depth.set(b.id, b.parentId && byId.has(b.parentId) ? d(byId.get(b.parentId)) + 1 : 0);
                        return depth.get(b.id);
                    };
                    const order = [];
                    const walk = (parent, lvl) => o.scene.bones.filter(b => (b.parentId && byId.has(b.parentId) ? b.parentId : null) === parent).forEach(b => {
                        order.push([b, lvl]);
                        walk(b.id, lvl + 1);
                    });
                    walk(null, 0);
                    for (const [b, lvl] of order.filter(([b]) => match(b.name))) {
                        const row = sideRow({ label: b.name, tag: b.type === 'LimbNode' ? '' : b.type, sel: state.pose.boneId === b.id, onClick: () => { state.pose.boneId = b.id; refreshSide(); } });
                        row.style.paddingLeft = 6 + Math.min(lvl, 12) * 10 + 'px';
                        list.append(row);
                    }
                }
            }
            list.append(groupHeader('images', `Textures (${state.folder.images.length})`));
            if (!state.collapsed.has('images')) for (const t of state.textures.filter(t => match(t.name))) list.append(sideRow({ label: t.name, img: t.thumb, tag: t.type.label }));
            count = `${state.folder.entries.length} files in ${state.folder.root || 'the folder'}`;
        }
    } else if (state.step === 'model') {
        if (o) {
            list.append(groupHeader('targets', 'Place on (target)'));
            if (!state.collapsed.has('targets')) for (const t of o.targets.filter(t => match(t.label))) {
                list.append(sideRow({ label: t.label, tag: t.slot.lod ? 'LOD' + t.slot.lod : 'Target', sel: t.id === state.targetId, onClick: () => { state.targetId = t.id; refreshSide(); renderPanel(); } }));
            }
        }
        list.append(groupHeader('parts', `New parts (${state.parts.length})`));
        if (!state.collapsed.has('parts')) for (const p of state.parts.filter(p => match(p.name))) {
            const eye = h('button', { class: 'eye', title: p.object.visible ? 'Hide' : 'Show', 'aria-label': (p.object.visible ? 'Hide ' : 'Show ') + p.name, onclick: e => { e.stopPropagation(); p.object.visible = !p.object.visible; refreshSide(); } }, p.object.visible ? '◉' : '○');
            list.append(sideRow({ label: p.name, tag: p.object.matrix.determinant() < 0 ? 'Mirrored' : 'Part', sel: state.selected === p, onClick: () => selectPart(p), eye }));
        }
        count = `${state.parts.length} new part(s)`;
    } else if (state.step === 'textures') {
        const types = [...new Set(state.textures.map(t => t.type.label))];
        const sel = h('select', { class: 'input', 'aria-label': 'Texture type' }, h('option', { value: 'all' }, 'All types'), types.map(t => h('option', { value: t, selected: state.textureFilter === t }, t)));
        sel.addEventListener('change', () => {
            state.textureFilter = sel.value;
            refreshSide();
            renderPanel();
        });
        tools.append(sel);
        const shown = visibleTextures();
        for (const t of shown) {
            list.append(sideRow({ label: t.name, img: t.thumb, tag: t.choice.mode === 'keep' ? t.type.label : 'Edited', dot: t.choice.mode === 'keep' ? (t.stats.detail > 0.02 ? 'warn' : '') : 'ok', title: `${t.name} · ${t.type.label}` }));
        }
        count = `${shown.length} / ${state.textures.length} textures`;
    } else {
        if (o) {
            ensurePlan();
            list.append(h('div', { class: 'group-title' }, 'Output meshes'));
            for (const s of o.scene.slots.filter(s => match(s.name))) {
                const e = state.plan?.get(s.id);
                const mode = e?.mode === 'replace' && e.parts.length ? 'replace' : e?.mode === 'hide' ? 'hide' : 'keep';
                list.append(sideRow({ label: s.name, tag: { replace: 'New', hide: 'Hidden', keep: 'Original' }[mode], dot: mode === 'replace' ? 'ok' : mode === 'hide' ? 'warn' : '' }));
            }
            list.append(h('div', { class: 'group-title' }, 'Export folder'));
            list.append(sideRow({ label: outputBase() + '.fbx', tag: 'FBX' }));
            for (const t of state.textures) list.append(sideRow({ label: t.entry.rel ?? t.name, img: t.thumb, tag: t.choice.mode === 'keep' ? 'Original' : 'Replaced' }));
        }
        count = state.compiled && !state.dirty ? 'Compiled and ready to export' : 'Not compiled yet';
    }
    $('sideCount').textContent = count;
}

function visibleTextures() {
    const q = state.filter.toLowerCase();
    return state.textures.filter(t => (state.textureFilter === 'all' || t.type.label === state.textureFilter) && (!q || t.name.toLowerCase().includes(q)));
}

function renderPanel() {
    const panel = $('panel');
    panel.replaceChildren();
    ({ import: panelImport, model: panelModel, textures: panelTextures, compile: panelCompile })[state.step](panel);
}

function button(label, onClick, opts = {}) {
    return h('button', { class: 'btn' + (opts.primary ? ' primary' : '') + (opts.small ? ' small' : '') + (opts.danger ? ' danger' : ''), onclick: onClick, disabled: opts.disabled, title: opts.title }, label);
}

function panelImport(panel) {
    const o = state.original;
    if (o) {
        panel.append(h('div', { class: 'toolbar' },
            button('Import another folder…', () => $('pickFolder').click()),
            button('Open FBX only…', () => $('pickFbx').click()),
            h('span', { class: 'note' }, state.folder?.root ? `From ${state.folder.root}` : '')));
    } else {
        panel.append(h('div', { class: 'drop' },
            h('div', { class: 'big-ico' }, '⇩'),
            h('div', { class: 'grow' },
                h('strong', {}, 'Import the folder you exported from ReSkate Studio'),
                h('p', {}, 'Pick the whole folder: the FBX (with its bones) and the texture images. You can also drop it on this window.')),
            h('div', { class: 'toolbar', style: 'margin:0' },
                button('Import folder…', () => $('pickFolder').click(), { primary: true }),
                button('Open FBX only…', () => $('pickFbx').click()))));
    }
    if (!o) {
        panel.append(h('div', { class: 'callout' }, 'Works with every cosmetic Studio exports: shoes, tops, hoodies, pants, hair, hats, costumes and decks. Each keeps its own bones.'));
        return;
    }
    const doc = o.doc;
    const plane = o.mirror;
    panel.append(h('div', { class: 'section' }, 'Cosmetic'));
    panel.append(h('div', { class: 'kv' },
        h('span', {}, 'File'), h('span', {}, o.entry.file.name),
        h('span', {}, 'Type'), h('span', {}, o.scene.type),
        h('span', {}, 'Format'), h('span', {}, `${doc.format === 'binary' ? 'Binary' : 'ASCII'} FBX ${(doc.version / 1000).toFixed(1)}`),
        h('span', {}, 'Bones'), h('span', {}, `${o.scene.bones.length} (${o.scene.slots.some(s => s.skinned) ? 'skinned' : 'not skinned'})`),
        h('span', {}, 'Mirror plane'), h('span', {}, `${AXES[plane.axis]} = ${fmt(plane.offset)}  (from ${plane.source})`),
        h('span', {}, 'Textures'), h('span', {}, `${state.textures.length}`)));
    panel.append(h('div', { class: 'section' }, 'Meshes'));
    const rows = o.scene.slots.map(s => h('tr', {},
        h('td', {}, s.name),
        h('td', { class: 'dim' }, s.lod ? 'LOD ' + s.lod : '—'),
        h('td', {}, s.data.cpCount.toLocaleString()),
        h('td', {}, (s.data.tris.length / 3).toLocaleString()),
        h('td', {}, s.clusters.length ? `${s.clusters.length} (up to ${s.maxInfluences} per vertex)` : 'none'),
        h('td', { class: 'dim' }, s.materials.map(m => m.name).join(', ') || '—'),
        h('td', { class: 'dim' }, s.shapes.length ? s.shapes.length + ' shapes' : '')));
    panel.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Mesh', 'LOD', 'Vertices', 'Triangles', 'Bones', 'Material', ''].map(x => h('th', {}, x)))), h('tbody', {}, rows)));
    if (o.scene.warnings.length) panel.append(h('div', { class: 'callout warn' }, h('ul', {}, o.scene.warnings.map(w => h('li', {}, w)))));
}

function panelModel(panel) {
    const p = state.selected;
    const t = currentTarget();
    const targetSel = h('select', { class: 'input', 'aria-label': 'Target' }, (state.original?.targets ?? []).map(x => h('option', { value: x.id, selected: x.id === state.targetId }, x.label)));
    targetSel.addEventListener('change', () => {
        state.targetId = targetSel.value;
        refreshSide();
    });
    panel.append(h('div', { class: 'toolbar' },
        button('Import new model…', () => $('pickModel').click(), { primary: !state.parts.length }),
        state.original ? targetSel : null,
        button('Auto-place', () => { if (!p) return say('Select a new part first.', 'warn'); pushUndo(); autoPlace(p, t); say(`Placed on ${t?.label}.`); }, { disabled: !p || !t, title: 'Find the best orientation, size and position on the target' }),
        button('Fit size', () => { if (!p || !t) return; pushUndo(); p.object.updateMatrix(); setMatrix(p, fitToPiece(p.data, p.object.matrix, t.piece)); say('Sized to the target, rotation kept.'); }, { disabled: !p || !t, title: 'Match the target size and centre, keep the rotation' }),
        button('Duplicate & mirror', () => duplicate(p, true), { disabled: !p, title: 'For the other shoe, glove or side (M)' }),
        button('Duplicate', () => duplicate(p, false), { disabled: !p }),
        button('Split', () => splitPart(p), { disabled: !p || p.data.pieces.length < 2, title: 'One part per mesh in the model' }),
        button('Delete', () => removePart(p), { disabled: !p, danger: true })));
    if (!state.parts.length) {
        panel.append(h('div', { class: 'drop' },
            h('div', { class: 'big-ico' }, '+'),
            h('div', {},
                h('strong', {}, 'Bring in the model that replaces the cosmetic'),
                h('p', {}, 'FBX, OBJ or GLB, in any size or orientation. It is turned, sized and placed on the target for you; its own bones (if any) are ignored.'))));
        return;
    }
    if (!p) {
        panel.append(h('div', { class: 'callout' }, 'Select a new part in the list or click it in the view to move, rotate or scale it.'));
    } else {
        panel.append(h('div', { class: 'section' }, `Placement · ${p.name}`));
        const form = h('div', { class: 'grid-form', id: 'transformForm' });
        const num = (key, axis, step) => {
            const inp = h('input', { class: 'input num axis-' + 'xyz'[axis], type: 'number', step, 'data-key': key, 'data-axis': axis, 'aria-label': `${key} ${AXES[axis]}` });
            inp.addEventListener('change', () => applyTransformInputs());
            return inp;
        };
        form.append(h('span', { class: 'lbl' }, 'Position'), num('pos', 0, 0.01), num('pos', 1, 0.01), num('pos', 2, 0.01), h('span'));
        form.append(h('span', { class: 'lbl' }, 'Rotation °'), num('rot', 0, 5), num('rot', 1, 5), num('rot', 2, 5), h('span', {}, button('↺ 90° Y', () => { pushUndo(); p.object.rotateY(Math.PI / 2); markDirty(); renderTransform(); }, { small: true })));
        form.append(h('span', { class: 'lbl' }, 'Scale'), num('scl', 0, 0.01), num('scl', 1, 0.01), num('scl', 2, 0.01), h('span'));
        panel.append(form);
        const uni = h('input', { type: 'range', min: '-2', max: '2', step: '0.01', value: '0', 'aria-label': 'Uniform scale' });
        let base = null;
        uni.addEventListener('pointerdown', () => { pushUndo(); base = p.object.scale.clone(); });
        uni.addEventListener('input', () => {
            base ??= p.object.scale.clone();
            p.object.scale.copy(base).multiplyScalar(2 ** Number(uni.value));
            markDirty();
            renderTransform();
        });
        uni.addEventListener('change', () => { base = null; uni.value = '0'; });
        panel.append(h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, 'Uniform scale'), h('div', { class: 'slider-row grow' }, h('span', { class: 'mono' }, '½×'), uni, h('span', { class: 'mono' }, '2×'))));
        renderTransform();
    }
    if (p) {
        const full = p.data.full ?? p.data;
        const fullTris = full.index.length / 3;
        const now = p.data.index.length / 3;
        const budget = recommendedBudget();
        const levels = [...new Set([0, budget, Math.round(budget / 2), budget * 2, 40000, 60000, p.data.detail ?? 0].filter(n => n === 0 || n < fullTris))].sort((a, b) => (a === 0) - (b === 0) || a - b);
        const detail = h('select', { class: 'input', 'aria-label': 'Detail' }, levels.map(n => h('option', { value: String(n), selected: n === 0 ? now === fullTris : p.data.detail === n },
            n === 0 ? `Full detail (${fullTris.toLocaleString()})` : `${n.toLocaleString()} triangles${n === budget ? ' (recommended)' : ''}`)));
        detail.addEventListener('change', () => busy('Simplifying…', () => setDetail(p, Number(detail.value))));
        panel.append(h('div', { class: 'section' }, 'Detail'));
        panel.append(h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, 'Triangles'), detail,
            h('span', { class: 'dim', style: 'font-size:13px' }, `Now ${now.toLocaleString()}. The original has about ${Math.round(budget / 2).toLocaleString()} per piece; game meshes need to stay light.`)));
    }
    if (state.original && state.parts.length) {
        panel.append(h('div', { class: 'section' }, 'Materials'));
        const names = [...new Set(state.original.scene.slots.flatMap(s => s.materials.map(m => m.name)))];
        const newNames = [...new Set(state.parts.flatMap(x => x.data.materialNames))];
        for (const n of newNames) {
            const sel = h('select', { class: 'input' }, names.map(o => h('option', { value: o, selected: state.materialMap.get(n) === o }, o)));
            sel.addEventListener('change', () => {
                state.materialMap.set(n, sel.value);
                refreshPreviewTextures();
                markDirty();
            });
            panel.append(h('div', { class: 'form-row' }, h('span', { class: 'lbl', title: n }, n), h('span', { class: 'dim' }, '→ uses'), sel));
        }
    }
    const ghost = h('input', { type: 'range', min: '0', max: '100', value: String(state.settings.ghost), 'aria-label': 'Original opacity' });
    ghost.addEventListener('input', () => {
        state.settings.ghost = Number(ghost.value);
        applyGhost();
    });
    ghost.addEventListener('change', saveSettings);
    panel.append(h('div', { class: 'section' }, 'View'));
    panel.append(h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, 'Original see-through'), h('div', { class: 'slider-row grow' }, ghost)));
}

function renderTransform() {
    const form = $('transformForm');
    const p = state.selected;
    if (!form || !p) return;
    const o = p.object;
    const e = new Euler().setFromQuaternion(o.quaternion, 'XYZ');
    for (const inp of form.querySelectorAll('input')) {
        if (document.activeElement === inp) continue;
        const a = Number(inp.dataset.axis);
        const v = inp.dataset.key === 'pos' ? o.position.getComponent(a) : inp.dataset.key === 'rot' ? MathUtils.radToDeg(e.toArray()[a]) : o.scale.getComponent(a);
        inp.value = fmt(v, inp.dataset.key === 'rot' ? 2 : 4);
    }
    vp.selectionBox.setFromObject(o);
}

function applyTransformInputs() {
    const form = $('transformForm');
    const p = state.selected;
    if (!form || !p) return;
    pushUndo();
    const val = (k, a) => Number(form.querySelector(`[data-key=${k}][data-axis="${a}"]`).value);
    const pos = [0, 1, 2].map(a => val('pos', a));
    const rot = [0, 1, 2].map(a => MathUtils.degToRad(val('rot', a)));
    const scl = [0, 1, 2].map(a => val('scl', a));
    if ([...pos, ...rot, ...scl].some(x => !Number.isFinite(x)) || scl.some(x => x === 0)) return say('Enter numbers (scale cannot be 0).', 'warn');
    p.object.position.set(...pos);
    p.object.quaternion.setFromEuler(new Euler(...rot, 'XYZ'));
    p.object.scale.set(...scl);
    markDirty();
    renderTransform();
}

function panelTextures(panel) {
    const edited = state.textures.filter(t => t.choice.mode !== 'keep').length;
    panel.append(h('div', { class: 'toolbar' },
        button('Load new model textures…', () => $('pickModelTextures').click(), { title: 'A folder of textures made for your new model; they are matched by name (base colour, normal, ...)' }),
        button('Flatten old-layout textures', neutralise, { title: 'Textures with detail painted for the old mesh become one flat colour' }),
        h('span', { class: 'vp-spacer' }),
        h('span', { class: 'note' }, `${state.textures.length} textures / ${edited} edited`)));
    if (!state.textures.length) {
        panel.append(h('div', { class: 'callout' }, state.original ? 'The export folder had no texture images. You can still compile and export the mesh.' : 'Import a cosmetic first.'));
        return;
    }
    const groups = atlasGroups();
    const anyGroup = [...groups.values()][0];
    const newNames = [...new Set(state.parts.flatMap(p => p.data.materialNames))];
    if (anyGroup || (!state.combine && newNames.length > 1)) {
        const on = h('input', { type: 'checkbox', checked: state.combine });
        on.addEventListener('change', () => {
            state.combine = on.checked;
            for (const t of state.textures) if (t.choice.mode === 'atlas' && !state.combine) t.choice = { mode: 'keep' };
            if (state.combine) autoAssignModelTextures();
            markDirty();
            refreshPreviewTextures();
            refresh();
        });
        const box = h('div', { class: 'callout atlas' });
        box.append(h('label', { class: 'check' }, on, h('span', {}, h('strong', {}, `Combine the new model's ${newNames.length} materials into one texture set`))));
        if (anyGroup) {
            const preview = drawAtlas(200, 200, anyGroup.names.map(name => ({ rect: anyGroup.layout.get(name), source: modelTexture(name, 'basecolor')?.canvas ?? null, fill: '#3a3f44' })));
            const g = preview.getContext('2d');
            g.font = 'bold 11px Arial';
            g.textAlign = 'center';
            for (const name of anyGroup.names) {
                const r = anyGroup.layout.get(name);
                g.strokeStyle = '#0091ff';
                g.strokeRect(r.x * 200 + 0.5, (1 - r.y - r.h) * 200 + 0.5, r.w * 200 - 1, r.h * 200 - 1);
                g.fillStyle = '#fff';
                g.fillText(name, (r.x + r.w / 2) * 200, (1 - r.y - r.h / 2) * 200);
            }
            preview.className = 'atlas-preview';
            const missing = anyGroup.names.filter(name => !modelTexture(name, 'basecolor'));
            box.append(h('div', { class: 'atlas-row' }, preview, h('div', {},
                h('p', {}, `The cosmetic has one texture set, so ${anyGroup.names.join(', ')} each get a part of it (bigger surfaces get more room). Their UVs are moved to match when you compile.`),
                missing.length
                    ? h('p', { class: 'status-warn' }, `No base colour found for ${missing.join(', ')}. Use Load new model textures… and pick the folder with files like ${missing[0].replace(/\s+/g, '_')}_Base_color.png.`)
                    : h('p', { class: 'status-ok' }, 'Base colour found for every material.'))));
        } else {
            box.append(h('p', {}, 'Off: every material keeps its own UVs, so they overlap in the one texture set.'));
        }
        panel.append(box);
    }
    const rows = visibleTextures().map(t => {
        const sourceSel = h('select', { class: 'input', 'aria-label': 'Source for ' + t.name },
            h('option', { value: 'keep', selected: t.choice.mode === 'keep' }, 'Original'),
            h('option', { value: 'flat', selected: t.choice.mode === 'flat' }, 'Flat colour'),
            groups.get(t.material ?? defaultOriginalMaterial()) ? h('option', { value: 'atlas', selected: t.choice.mode === 'atlas' }, 'Combined new model') : null,
            t.choice.mode === 'image' ? h('option', { value: 'image', selected: true }, 'Image: ' + t.choice.name) : null,
            state.modelTextures.map(m => h('option', { value: 'model:' + m.id, selected: t.choice.mode === 'model' && t.choice.id === m.id }, 'New model: ' + m.name)));
        sourceSel.addEventListener('change', () => {
            const v = sourceSel.value;
            if (v === 'keep') t.choice = { mode: 'keep' };
            else if (v === 'flat') t.choice = { mode: 'flat', colour: tex.neutralColour(t.type.key, t.stats.average) };
            else if (v === 'atlas') t.choice = { mode: 'atlas', type: t.type.key };
            else if (v.startsWith('model:')) t.choice = { mode: 'model', id: v.slice(6) };
            refreshPreviewTextures();
            refresh();
        });
        const colour = h('input', { type: 'color', value: t.choice.mode === 'flat' ? t.choice.colour : tex.neutralColour(t.type.key, t.stats.average), title: 'Flat colour', 'aria-label': 'Flat colour for ' + t.name });
        colour.addEventListener('input', () => {
            t.choice = { mode: 'flat', colour: colour.value };
            refreshPreviewTextures();
        });
        colour.addEventListener('change', () => refresh());
        const status = t.choice.mode === 'keep' && !t.flipGreen
            ? h('span', { class: t.stats.detail > 0.02 ? 'status-warn' : 'dim', title: t.stats.detail > 0.02 ? 'Painted for the old mesh layout: replace it or make it flat' : 'One flat colour: fits any mesh' }, t.stats.detail > 0.02 ? 'Old layout' : 'Fits any mesh')
            : h('span', { class: 'status-ok' }, 'Replaced');
        const thumbSrc = t.choice.mode === 'keep' && !t.flipGreen ? t.thumb : tex.thumbnail(outputCanvas(t));
        return h('tr', {},
            h('td', {}, h('span', { class: 'tname' }, h('img', { class: 'thumb', src: thumbSrc, alt: '' }), h('span', {}, t.type.label, h('span', { class: 'sub' }, t.name + (t.canvas ? ` · ${t.canvas.width}×${t.canvas.height}` : '') + (t.note ? ' · ' + t.note : ''))))),
            h('td', { class: 'dim' }, t.material ?? 'All'),
            h('td', {}, sourceSel),
            h('td', { class: 'nowrap' }, status),
            h('td', { class: 'actions' },
                t.type.key === 'normal' ? h('label', { class: 'check small', title: 'Flip the green channel (OpenGL and DirectX normal maps differ). Turn on if bumps look inverted in game.' }, (() => {
                    const cb = h('input', { type: 'checkbox', checked: !!t.flipGreen });
                    cb.addEventListener('change', () => { t.flipGreen = cb.checked; refreshPreviewTextures(); refresh(); });
                    return cb;
                })(), h('span', {}, 'Flip G')) : null,
                button('Replace…', () => { pendingImageFor = t; $('pickImage').click(); }, { small: true }),
                colour,
                button('Reset', () => { t.choice = { mode: 'keep' }; refreshPreviewTextures(); refresh(); }, { small: true, disabled: t.choice.mode === 'keep' })));
    });
    panel.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Texture', 'Material', 'Source', 'Status', ''].map(x => h('th', {}, x)))), h('tbody', {}, rows)));
    panel.append(h('div', { class: 'callout' }, 'Replacements are saved at the original size and in the original format, under the original file name, so ReSkate Studio picks them up in the same slots.'));
}

let pendingImageFor = null;

function panelCompile(panel) {
    const o = state.original;
    const ready = canCompile();
    panel.append(h('div', { class: 'toolbar' },
        button(state.compiled && !state.dirty ? 'Compile again' : 'Compile', () => runCompile(), { primary: true, disabled: !ready }),
        button('Export .fbx', exportFbx, { disabled: !ready }),
        button('Export folder (.zip)', exportZip, { disabled: !ready }),
        h('span', { class: 'note' }, ready ? (state.compiled && !state.dirty ? 'Up to date.' : 'Changes since the last compile.') : 'Needs a cosmetic and at least one new part.')));
    if (!o) return;
    ensurePlan();

    panel.append(h('div', { class: 'section' }, 'What goes where'));
    const rows = o.scene.slots.map(s => {
        const e = state.plan.get(s.id);
        const mode = h('select', { class: 'input', 'aria-label': 'Action for ' + s.name },
            h('option', { value: 'replace', selected: e.mode === 'replace' }, 'Use new parts'),
            h('option', { value: 'keep', selected: e.mode === 'keep' }, 'Keep original'),
            h('option', { value: 'hide', selected: e.mode === 'hide' }, 'Hide'));
        mode.addEventListener('change', () => {
            e.mode = mode.value;
            state.planManual = true;
            markDirty();
            refresh();
        });
        const chips = h('div', { class: 'chips' }, state.parts.map(p => {
            const cb = h('input', { type: 'checkbox', checked: e.parts.includes(p.id) });
            cb.addEventListener('change', () => {
                e.parts = cb.checked ? [...e.parts, p.id] : e.parts.filter(id => id !== p.id);
                if (cb.checked && e.mode !== 'hide') e.mode = 'replace';
                state.planManual = true;
                markDirty();
                refresh();
            });
            return h('label', { class: 'chip' }, cb, p.name);
        }));
        return h('tr', {}, h('td', {}, s.name, h('span', { class: 'sub' }, s.lod ? 'LOD ' + s.lod : '')), h('td', {}, mode), h('td', {}, state.parts.length ? chips : h('span', { class: 'dim' }, 'No new parts')));
    });
    panel.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Original mesh', 'Action', 'New parts in it'].map(x => h('th', {}, x)))), h('tbody', {}, rows)));
    if (state.planManual) {
        panel.append(h('div', { class: 'toolbar', style: 'margin-top:6px' }, button('Reset to automatic', () => { state.planManual = false; state.plan = null; ensurePlan(); markDirty(); refresh(); }, { small: true })));
    }

    const s = state.settings;
    const infl = h('select', { class: 'input', 'aria-label': 'Bones per vertex' }, h('option', { value: '0' }, `Same as original (${Math.max(...o.scene.slots.map(x => x.maxInfluences), 0) || 4})`), [1, 2, 3, 4, 5, 6, 7, 8].map(n => h('option', { value: String(n), selected: Number(s.maxInfluences) === n }, String(n))));
    infl.addEventListener('change', () => { s.maxInfluences = Number(infl.value); saveSettings(); markDirty(); });
    const smooth = h('select', { class: 'input', 'aria-label': 'Weight smoothing' }, [0, 1, 2, 3, 4, 5].map(n => h('option', { value: String(n), selected: Number(s.smooth) === n }, n ? `${n} pass${n > 1 ? 'es' : ''}` : 'Off')));
    smooth.addEventListener('change', () => { s.smooth = Number(smooth.value); saveSettings(); markDirty(); });
    panel.append(h('div', { class: 'section' }, 'Bone weights'));
    panel.append(h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, 'Bones per vertex'), infl, h('span', { class: 'lbl', style: 'width:auto' }, 'Smoothing'), smooth));

    const r = state.compiled;
    if (r) {
        panel.append(h('div', { class: 'section' }, state.dirty ? 'Last result (out of date)' : 'Result'));
        const rr = r.report.map(x => h('tr', {},
            h('td', {}, x.slot),
            h('td', { class: 'dim' }, { replace: 'New parts', keep: 'Original', hide: 'Hidden' }[x.mode]),
            h('td', {}, x.vertices.toLocaleString()),
            h('td', {}, x.triangles.toLocaleString()),
            h('td', {}, x.mode === 'replace' ? String(x.bones) : '—'),
            h('td', {}, x.mode === 'replace' ? String(x.maxInfluences) : '—')));
        panel.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Mesh', 'Source', 'Vertices', 'Triangles', 'Bones used', 'Per vertex'].map(x => h('th', {}, x)))), h('tbody', {}, rr)));
        if (r.warnings.length) panel.append(h('div', { class: 'callout warn' }, h('ul', {}, r.warnings.map(w => h('li', {}, w)))));

        if (o.scene.bones.length) {
            panel.append(h('div', { class: 'section' }, 'Bend test'));
            const used = new Set();
            for (const pv of r.previews) {
                const slot = o.scene.slots.find(x => x.id === pv.slotId);
                if (pv.weights) for (const b of pv.weights.bone) used.add(slot.clusters[b]?.boneId);
            }
            const choices = o.scene.bones.filter(b => used.has(b.id));
            if (!choices.some(b => b.id === state.pose.boneId) && choices.length) state.pose.boneId = (choices.find(b => /foot|ankle|spine|head/i.test(b.name)) ?? choices[0]).id;
            const boneSel = h('select', { class: 'input', 'aria-label': 'Bone' }, choices.map(b => h('option', { value: b.id, selected: b.id === state.pose.boneId }, b.name)));
            const axisSel = h('select', { class: 'input', 'aria-label': 'Axis' }, AXES.map(a => h('option', { value: a.toLowerCase(), selected: state.pose.axis === a.toLowerCase() }, a + ' axis')));
            const angle = h('input', { type: 'range', min: '-90', max: '90', value: String(state.pose.angle), 'aria-label': 'Angle' });
            const anim = h('input', { type: 'checkbox', checked: state.pose.animate });
            const apply = () => {
                state.pose = { boneId: boneSel.value, axis: axisSel.value, angle: Number(angle.value), animate: anim.checked };
                vp.setPose(state.pose);
            };
            for (const el of [boneSel, axisSel, angle, anim]) el.addEventListener('input', apply);
            panel.append(h('div', { class: 'form-row' }, boneSel, axisSel, h('div', { class: 'slider-row grow' }, angle), h('label', { class: 'check' }, anim, h('span', {}, 'Swing'))));
            panel.append(h('p', { class: 'dim', style: 'margin:4px 0;font-size:13px' }, 'Bend a bone: the new model should follow it the way the original did. Turn on Weights above to see which bone drives each area.'));
            apply();
        }
    }
    panel.append(h('div', { class: 'callout' },
        h('strong', {}, 'Next, in ReSkate Studio: '),
        'open this cosmetic, load the exported FBX as its mesh, and replace any textures you changed with the ones from the exported folder. Then export the .fbmod as usual.'));
}

// ---- visibility & view toggles ---------------------------------------------

function applyVisibility() {
    vp.originalGroup.visible = $('showOriginal').checked;
    vp.partsGroup.visible = $('showParts').checked;
    vp.compiledGroup.visible = $('showCompiled').checked;
    vp.bonesGroup.visible = $('showBones').checked;
    vp.selectionBox.visible = state.step === 'model' && !!state.selected && vp.partsGroup.visible;
}

function applyGhost() {
    const ghost = state.step === 'model' && state.parts.length > 0;
    const opacity = ghost ? 1 - state.settings.ghost / 100 : 1;
    for (const m of originalMaterials.values()) {
        m.transparent = opacity < 1;
        m.opacity = opacity;
        m.depthWrite = opacity >= 1;
        m.needsUpdate = true;
    }
}

function applyWeights() {
    const on = $('showWeights').checked;
    const o = state.original;
    if (!o) return;
    for (const [slotId, mesh] of vp.originalMeshes ?? []) {
        const slot = o.scene.slots.find(s => s.id === slotId);
        if (!mesh.userData.materials) mesh.userData.materials = mesh.material;
        if (on && slot.skinned) {
            if (!mesh.geometry.attributes.color) mesh.geometry.setAttribute('color', new BufferAttribute(originalWeightColours(slot, boneColour), 3));
            mesh.material = weightMaterial;
        } else mesh.material = mesh.userData.materials;
    }
    for (const mesh of vp.compiledMeshes?.values() ?? []) {
        if (!mesh.userData.materials) mesh.userData.materials = mesh.material;
        if (on && mesh.userData.weightColours) {
            if (!mesh.geometry.attributes.color) mesh.geometry.setAttribute('color', new BufferAttribute(mesh.userData.weightColours, 3));
            mesh.material = weightMaterial;
        } else mesh.material = mesh.userData.materials;
    }
}

for (const id of ['showOriginal', 'showParts', 'showCompiled', 'showBones']) $(id).addEventListener('change', applyVisibility);
$('showWeights').addEventListener('change', applyWeights);
$('fit').addEventListener('click', () => vp.fit());
document.querySelectorAll('#gizmoModes .btn').forEach(b => b.addEventListener('click', () => {
    vp.gizmo.setMode(b.dataset.mode);
    renderStage();
}));

// ---- pages: help & settings --------------------------------------------------

function setPage(page) {
    state.page = page;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    for (const p of ['compiler', 'help', 'settings']) $('page-' + p).hidden = p !== page;
    $('pageTitle').textContent = { compiler: 'MESH COMPILER', help: 'HOW IT WORKS', settings: 'SETTINGS' }[page];
    if (page === 'settings') renderSettings();
    if (page === 'compiler') vp.resize();
}

function renderHelp() {
    $('page-help').innerHTML = `
<h2>Put any model on a ReSkate cosmetic's bones</h2>
<p>The Mesh Compiler takes a cosmetic you exported from ReSkate Studio, swaps its mesh for a new model, and gives the new model the original bones and skin weights. The result is an FBX that ReSkate Studio can load back for that cosmetic. Everything runs in this page; no files leave your computer.</p>
<div class="card"><h3>1 · Import cosmetic</h3><ol>
<li>In ReSkate Studio, export the cosmetic you want to replace (shoes, top, hoodie, pants, hair, hat, costume or deck).</li>
<li>Press <b>Import folder…</b> and pick that export folder, or drop the folder on this window.</li>
<li>The FBX is read with its bones and every mesh; the texture images are listed separately.</li></ol></div>
<div class="card"><h3>2 · New model</h3><ol>
<li>Press <b>Import new model…</b> (FBX, OBJ or GLB). It is turned, sized and placed on the selected target automatically, using the original's measurements.</li>
<li>Models made for renders are often far too heavy for the game (hundreds of thousands of triangles). They are simplified automatically to about twice the original's detail; change it under <b>Detail</b>.</li>
<li>Fine-tune with the handles (<kbd>W</kbd> move, <kbd>E</kbd> rotate, <kbd>R</kbd> scale) or type exact values. <b>Fit size</b> re-sizes without changing the rotation.</li>
<li>For pairs, select the placed part and press <b>Duplicate &amp; mirror</b> (<kbd>M</kbd>): the copy lands on the other side, mirrored across the character's centre.</li>
<li>If your model is several pieces (for example both shoes in one file), use <b>Split</b> and place each piece on its own target.</li></ol></div>
<div class="card"><h3>3 · Textures</h3>
<p>Textures are painted for a mesh's UV layout, so the original ones will look scrambled on a new model. For each texture choose <b>Replace…</b> (your own image), a texture that came with the new model, or a <b>Flat colour</b>. <b>Load new model textures…</b> takes a whole folder (for example a Substance export with <i>Body_Base_color.png</i>, <i>Sole_Normal_OpenGL.png</i>, …) and matches each file to its material and type by name. Replacements are written at the original size and format under the original names.</p>
<p>A cosmetic has one texture set, but a new model often has several materials (Body, Sole, Laces…). These are <b>combined</b> automatically: each material gets a part of the texture (bigger surfaces get more room) and its UVs are moved to match when you compile. If bumps look inverted in game, tick <b>Flip G</b> on the normal map (OpenGL and DirectX normal maps differ).</p></div>
<div class="card"><h3>4 · Compile &amp; export</h3><ol>
<li>Press <b>Compile</b>. Each new part goes into the original mesh it sits on (in every LOD). Each new vertex takes the bone weights of the closest point on the original surface, so it bends exactly like the original did there.</li>
<li>Check it: turn on <b>Weights</b> to colour the mesh by bone, and use the <b>Bend test</b> to swing a bone.</li>
<li><b>Export folder (.zip)</b> saves the new FBX with all textures; <b>Export .fbx</b> saves just the mesh. Load them into ReSkate Studio for the cosmetic and export your .fbmod.</li></ol></div>
<h3>What is kept</h3>
<p>The skeleton, bind pose, bone names, materials, texture links and every id in the original FBX are written back unchanged. Only the mesh data, the per-bone vertex lists and any blend shapes are rebuilt, so the file keeps the exact structure Studio exported.</p>
<h3>Tips</h3><ul>
<li>Keep new models light: one game mesh section holds at most 65,535 vertices.</li>
<li>Parts that should not follow the body (a rigid deck, a hat) still get weights from the closest original bone, which is what you want.</li>
<li>Keys: <kbd>F</kbd> frame, <kbd>W</kbd>/<kbd>E</kbd>/<kbd>R</kbd> handles, <kbd>M</kbd> duplicate &amp; mirror, <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate, <kbd>Delete</kbd> remove part, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo.</li></ul>`;
}

function renderSettings() {
    const page = $('page-settings');
    page.replaceChildren();
    const s = state.settings;
    const sel = (key, options, label, help) => {
        const el = h('select', { class: 'input' }, options.map(([v, t]) => h('option', { value: v, selected: String(s[key]) === String(v) }, t)));
        el.addEventListener('change', () => {
            s[key] = isNaN(Number(el.value)) ? el.value : Number(el.value);
            saveSettings();
            onSettingsChanged(key);
        });
        return h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, label), el, help ? h('span', { class: 'dim', style: 'font-size:13px' }, help) : null);
    };
    page.append(h('h2', {}, 'Compiler settings'));
    page.append(h('div', { class: 'card' },
        h('h3', {}, 'Bone weights'),
        sel('maxInfluences', [[0, 'Same as the original'], ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, String(n)])], 'Bones per vertex', 'Most game meshes use 4.'),
        sel('smooth', [0, 1, 2, 3, 4, 5].map(n => [n, n ? `${n} pass${n > 1 ? 'es' : ''}` : 'Off']), 'Smoothing', 'Blends weights with neighbouring vertices; helps where the new model is far from the old surface.'),
        sel('unassigned', [['keep', 'Keep the original mesh'], ['hide', 'Hide it']], 'Meshes with no new part', 'For example the second mesh of a hoodie you only partly replaced.')));
    const offset = h('input', { class: 'input num', type: 'number', step: '0.001', value: s.mirrorOffset, placeholder: 'auto' });
    offset.addEventListener('change', () => {
        s.mirrorOffset = offset.value;
        saveSettings();
        onSettingsChanged('mirror');
    });
    page.append(h('div', { class: 'card' },
        h('h3', {}, 'Mirror'),
        sel('mirrorAxis', [['auto', 'Automatic (from left/right bones)'], ['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], 'Mirror axis'),
        h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, 'Plane position'), offset, h('span', { class: 'dim', style: 'font-size:13px' }, 'Leave empty to use the character\'s centre.')),
        state.original ? h('p', {}, `Now: ${AXES[state.original.mirror.axis]} = ${fmt(state.original.mirror.offset)} (from ${state.original.mirror.source}).`) : null));
    page.append(h('div', { class: 'card' }, h('h3', {}, 'Reset'), h('p', {}, 'Settings are remembered in this browser.'), button('Restore defaults', () => {
        state.settings = { ...defaults };
        saveSettings();
        onSettingsChanged('mirror');
        renderSettings();
    })));
}

function onSettingsChanged(key) {
    if (state.original && (key === 'mirror' || key === 'mirrorAxis')) state.original.mirror = mirrorPlane(state.original.scene, state.original.targets);
    if (key === 'unassigned' && !state.planManual) state.plan = null;
    markDirty();
    renderSettings();
}

// ---- wiring --------------------------------------------------------------------

document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => setPage(b.dataset.page)));
document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => setStep(b.dataset.step)));
$('emptyImport').addEventListener('click', () => $('pickFolder').click());
$('compileTop').addEventListener('click', () => {
    if (state.step !== 'compile') setStep('compile');
    runCompile();
});
$('exportFbxTop').addEventListener('click', exportFbx);
$('nextStep').addEventListener('click', () => {
    if (state.step === 'compile') return exportZip();
    setStep(STEPS[STEPS.indexOf(state.step) + 1]);
});
$('outputName').addEventListener('input', () => {
    $('outputName').dataset.auto = '0';
    if (state.step === 'compile') refreshSide();
});

$('pickFolder').addEventListener('change', e => {
    const entries = entriesFromInput(e.target);
    e.target.value = '';
    if (entries.length) busy('Reading the export folder…', () => importOriginal(entries));
});
$('pickFbx').addEventListener('change', e => {
    const entries = entriesFromInput(e.target);
    e.target.value = '';
    if (entries.length) busy('Reading ' + entries[0].file.name + '…', () => importOriginal(entries));
});
$('pickModel').addEventListener('change', e => {
    const entries = entriesFromInput(e.target);
    e.target.value = '';
    if (entries.length) busy('Reading ' + entries[0].file.name + '…', async () => {
        if (state.step !== 'model') setStep('model');
        await importModel(entries[0]);
        refresh();
    });
});
$('pickModelTextures').addEventListener('change', e => {
    const entries = entriesFromInput(e.target);
    e.target.value = '';
    if (entries.length) busy('Reading textures…', () => importModelTextures(entries));
});
$('pickImage').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    const t = pendingImageFor;
    pendingImageFor = null;
    if (!file || !t) return;
    await busy('Reading ' + file.name + '…', async () => {
        const canvas = await tex.decodeImage(file);
        if (canvas.unsupported) throw new Error(`${canvas.unsupported} DDS images can't be read here. Use PNG.`);
        t.choice = { mode: 'image', canvas, name: file.name };
        refreshPreviewTextures();
        refresh();
        const size = t.canvas && (t.canvas.width !== canvas.width || t.canvas.height !== canvas.height) ? ` It will be saved at ${t.canvas.width}×${t.canvas.height} like the original.` : '';
        say(`${file.name} replaces ${t.name}.${size}`);
    });
});

// Drag and drop anywhere.
let dragDepth = 0;
window.addEventListener('dragenter', e => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    dragDepth++;
    $('dropHint').hidden = false;
    $('dropHint').firstElementChild.textContent = state.original && state.step !== 'import' ? 'Drop a model (or a texture folder) to import' : 'Drop the Studio export folder to import';
});
window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropHint').hidden = true;
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    const entries = await entriesFromDrop(e.dataTransfer);
    if (!entries.length) return;
    const models = entries.filter(x => MODEL_EXT.test(x.file.name));
    const hasFbx = entries.some(x => /\.fbx$/i.test(x.file.name));
    const hasImages = entries.some(x => tex.IMAGE_EXT.test(x.file.name));
    if (hasFbx && (!state.original || state.step === 'import' || (hasImages && state.step !== 'model'))) {
        if (state.page !== 'compiler') setPage('compiler');
        await busy('Reading the export folder…', () => importOriginal(entries));
        setStep('import');
    } else if (models.length && state.original) {
        if (state.page !== 'compiler') setPage('compiler');
        await busy('Reading ' + models[0].file.name + '…', async () => {
            if (state.step !== 'model') setStep('model');
            await importModel(models[0]);
            refresh();
        });
    } else if (hasImages && state.original) {
        await busy('Reading textures…', () => importModelTextures(entries));
        setStep('textures');
    } else {
        say('Drop the folder exported from ReSkate Studio first.', 'warn');
    }
});

// Splitter between the view and the panel.
{
    const split = $('splitter');
    let startY = 0;
    let startH = 0;
    split.addEventListener('pointerdown', e => {
        startY = e.clientY;
        startH = $('panel').offsetHeight;
        split.setPointerCapture(e.pointerId);
    });
    split.addEventListener('pointermove', e => {
        if (!split.hasPointerCapture(e.pointerId)) return;
        const max = window.innerHeight * 0.7;
        $('panel').style.height = Math.max(120, Math.min(max, startH + (startY - e.clientY))) + 'px';
    });
}

window.addEventListener('keydown', e => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range';
    if (typing || state.page !== 'compiler') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        undo();
    } else if ((e.ctrlKey || e.metaKey) && k === 'd') {
        e.preventDefault();
        duplicate(state.selected, false);
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
    } else if (k === 'f') vp.fit();
    else if (k === 'w' || k === 'e' || k === 'r') {
        vp.gizmo.setMode({ w: 'translate', e: 'rotate', r: 'scale' }[k]);
        renderStage();
    } else if (k === 'm') duplicate(state.selected, true);
    else if (k === 'delete' || k === 'backspace') removePart(state.selected);
    else if (k === 'escape') selectPart(null);
});

// Exposed for scripted use and testing.
window.meshCompiler = { state, importOriginal, importModel, runCompile, duplicate, autoPlace, setStep, setDetail, uvTransforms, exportFbx, exportZip, viewport: vp, selectPart };

renderHelp();
setStep('import');
