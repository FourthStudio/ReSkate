// Several materials of a new model sharing the cosmetic's one texture set:
// each gets a rectangle of the texture (bigger surfaces get more room), its
// UVs are squeezed into that rectangle, and its textures are drawn there.

const PAD = 0.004; // gutter around each rectangle, in UV units (~4 px at 1024)

// areas: Map name -> surface area. Returns Map name -> {x, y, w, h} in UV
// space (v up), splitting the square in two along its longer side each time.
export function atlasLayout(areas) {
    const items = [...areas].map(([name, a]) => ({ name, w: Math.sqrt(Math.max(a, 1e-12)) })).sort((a, b) => b.w - a.w);
    const out = new Map();
    const split = (list, r) => {
        if (list.length === 1) {
            out.set(list[0].name, r);
            return;
        }
        const a = [];
        const b = [];
        let sa = 0;
        let sb = 0;
        for (const it of list) {
            if (sa <= sb) {
                a.push(it);
                sa += it.w;
            } else {
                b.push(it);
                sb += it.w;
            }
        }
        const f = sa / (sa + sb);
        if (r.w >= r.h) {
            split(a, { x: r.x, y: r.y, w: r.w * f, h: r.h });
            split(b, { x: r.x + r.w * f, y: r.y, w: r.w * (1 - f), h: r.h });
        } else {
            split(a, { x: r.x, y: r.y + r.h * (1 - f), w: r.w, h: r.h * f });
            split(b, { x: r.x, y: r.y, w: r.w, h: r.h * (1 - f) });
        }
    };
    if (items.length) split(items, { x: 0, y: 0, w: 1, h: 1 });
    return out;
}

// u' = ox + u * sx, v' = oy + v * sy, inside the rectangle's gutter.
export function uvTransform(r) {
    return { ox: r.x + PAD, oy: r.y + PAD, sx: Math.max(r.w - 2 * PAD, 1e-6), sy: Math.max(r.h - 2 * PAD, 1e-6) };
}

// entries: [{ rect, source: canvas | null, fill: '#rrggbb' }]
export function drawAtlas(width, height, entries) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    for (const { rect, source, fill } of entries) {
        const t = uvTransform(rect);
        const outer = toPixels(rect.x, rect.y, rect.w, rect.h, width, height);
        const inner = toPixels(t.ox, t.oy, t.sx, t.sy, width, height);
        if (source && source.width) {
            // Stretched copy underneath fills the gutter with edge colours.
            g.drawImage(source, outer.x, outer.y, outer.w, outer.h);
            g.drawImage(source, inner.x, inner.y, inner.w, inner.h);
        } else {
            g.fillStyle = fill;
            g.fillRect(outer.x, outer.y, outer.w, outer.h);
        }
    }
    return c;
}

// UV rectangle (v up) to canvas pixels (y down).
function toPixels(x, y, w, h, width, height) {
    return { x: x * width, y: (1 - y - h) * height, w: w * width, h: h * height };
}

export function flipGreen(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height);
    for (let i = 1; i < img.data.length; i += 4) img.data[i] = 255 - img.data[i];
    g.putImageData(img, 0, 0);
    return c;
}

// Surface area of each material of a part (local units, scaled by the part's
// size in the scene).
export function materialAreas(part, scale = 1, into = new Map()) {
    const p = part.positions;
    for (let t = 0; t < part.index.length / 3; t++) {
        const a = part.index[t * 3] * 3, b = part.index[t * 3 + 1] * 3, c = part.index[t * 3 + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * scale * scale;
        const name = part.materialNames[part.triMaterial[t]];
        into.set(name, (into.get(name) ?? 0) + area);
    }
    return into;
}
