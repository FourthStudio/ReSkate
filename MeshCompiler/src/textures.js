// Texture files: what each one is for, decoding (PNG/JPG/WebP/BMP/GIF, TGA,
// DDS), and writing a replacement in the original file's format and size.

export const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tga|dds)$/i;

const TYPES = [
    ['pattern', 'Pattern', /pattern/],
    ['graphic', 'Graphic', /graphic|decal|logo|print/],
    ['normal', 'Normal', /normal|nrm|_n$|_nm$|nor$|_n_|_nm_/],
    ['roughness', 'Roughness', /rough/],
    ['metallic', 'Metallic', /metal/],
    ['ao', 'Ambient occlusion', /mixedao|occlusion|ambient|_ao$|_ao_|^ao_/],
    ['emissive', 'Emissive', /emiss|emission|glow/],
    ['opacity', 'Opacity', /opacity|alpha|transparen/],
    ['height', 'Height', /height|displace|bump/],
    ['specular', 'Specular', /spec|gloss|smooth/],
    ['mask', 'Mask', /mask|_m$|_ms$|_mp$|_id$|tint/],
    ['basecolor', 'Base colour', /base.?colou?r|albedo|diffuse|diff|_d$|_bc$|_col$|colou?r|_c$|_d_|_bc_/],
];

const NEUTRAL = { normal: '#8080ff', roughness: '#b3b3b3', metallic: '#000000', ao: '#ffffff', emissive: '#000000', opacity: '#ffffff', height: '#808080', specular: '#404040' };

export function textureType(fileName) {
    const base = fileName.replace(/\.[^.]+$/, '');
    const flat = base.toLowerCase().replace(/[\s-]+/g, '_');
    for (const [key, label, re] of TYPES) if (re.test(flat)) return { key, label };
    return { key: 'other', label: 'Texture' };
}

export function neutralColour(type, average) {
    return NEUTRAL[type] ?? average ?? '#ffffff';
}

const simplify = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Which material a texture belongs to: the longest material name its file
// name starts with (or contains), else the only material.
export function matchMaterial(fileName, materialNames) {
    const name = simplify(fileName.replace(/\.[^.]+$/, ''));
    const scored = materialNames
        .map(m => ({ m, s: simplify(m).replace(/mat(erial)?$/, '') }))
        .filter(x => x.s.length > 1 && (name.startsWith(x.s) || name.includes(x.s)))
        .sort((a, b) => b.s.length - a.s.length);
    if (scored.length) return scored[0].m;
    return materialNames.length === 1 ? materialNames[0] : null;
}

function canvasOf(width, height) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
}

function fromRgba(width, height, rgba) {
    const c = canvasOf(width, height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height), 0, 0);
    return c;
}

// -> HTMLCanvasElement, or null when the format can't be shown here.
export async function decodeImage(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'tga') {
        const d = decodeTga(new Uint8Array(await file.arrayBuffer()));
        return fromRgba(d.width, d.height, d.data);
    }
    if (ext === 'dds') {
        const d = decodeDds(new Uint8Array(await file.arrayBuffer()));
        if (!d.data) return Object.assign(canvasOf(d.width, d.height), { unsupported: d.format });
        return fromRgba(d.width, d.height, d.data);
    }
    const bitmap = await createImageBitmap(file);
    const c = canvasOf(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return c;
}

export function thumbnail(canvas, size = 56) {
    const c = canvasOf(size, size);
    const g = c.getContext('2d');
    g.fillStyle = '#26292c';
    g.fillRect(0, 0, size, size);
    if (canvas && !canvas.unsupported && canvas.width) g.drawImage(canvas, 0, 0, size, size);
    return c.toDataURL('image/png');
}

// Average colour and how much the image varies (0 = one flat colour).
export function imageStats(canvas) {
    if (!canvas || canvas.unsupported || !canvas.width) return { average: '#808080', detail: 1 };
    const c = canvasOf(32, 32);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let a = 0; a < 3; a++) sum[a] += d[i + a];
    const n = d.length / 4;
    const mean = sum.map(s => s / n);
    let dev = 0;
    for (let i = 0; i < d.length; i += 4) for (let a = 0; a < 3; a++) dev += (d[i + a] - mean[a]) ** 2;
    const detail = Math.sqrt(dev / (n * 3)) / 255;
    const hex = '#' + mean.map(m => Math.round(m).toString(16).padStart(2, '0')).join('');
    return { average: hex, detail };
}

export function flatCanvas(width, height, colour) {
    const c = canvasOf(width, height);
    const g = c.getContext('2d');
    g.fillStyle = colour;
    g.fillRect(0, 0, width, height);
    return c;
}

export function resized(canvas, width, height) {
    if (canvas.width === width && canvas.height === height) return canvas;
    const c = canvasOf(width, height);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, width, height);
    return c;
}

function rgbaOf(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
}

// Writes the canvas in the format of `fileName`'s extension.
export async function encodeImage(canvas, fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    if (ext === 'tga') return new Blob([encodeTga(canvas.width, canvas.height, rgbaOf(canvas))]);
    if (ext === 'bmp') return new Blob([encodeBmp(canvas.width, canvas.height, rgbaOf(canvas))]);
    if (ext === 'dds') return new Blob([encodeDds(canvas.width, canvas.height, rgbaOf(canvas))]);
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode ' + fileName))), mime, 0.95));
}

// ---- TGA ----------------------------------------------------------------

export function decodeTga(u8) {
    const idLen = u8[0];
    const cmapType = u8[1];
    const type = u8[2];
    const cmapLen = u8[5] | (u8[6] << 8);
    const cmapBits = u8[7];
    const width = u8[12] | (u8[13] << 8);
    const height = u8[14] | (u8[15] << 8);
    const bpp = u8[16];
    const desc = u8[17];
    let pos = 18 + idLen + (cmapType ? (cmapLen * cmapBits) >> 3 : 0);
    const bytes = bpp >> 3;
    const rle = type >= 9;
    const grey = type === 3 || type === 11;
    if (![2, 3, 10, 11].includes(type)) throw new Error('Unsupported TGA type ' + type);
    const out = new Uint8Array(width * height * 4);
    const px = new Uint8Array(4);
    const read = () => {
        if (grey) {
            px[0] = px[1] = px[2] = u8[pos];
            px[3] = bytes === 2 ? u8[pos + 1] : 255;
        } else if (bytes === 2) {
            const v = u8[pos] | (u8[pos + 1] << 8);
            px[0] = ((v >> 10) & 31) * 255 / 31;
            px[1] = ((v >> 5) & 31) * 255 / 31;
            px[2] = (v & 31) * 255 / 31;
            px[3] = 255;
        } else {
            px[0] = u8[pos + 2];
            px[1] = u8[pos + 1];
            px[2] = u8[pos];
            px[3] = bytes === 4 ? u8[pos + 3] : 255;
        }
        pos += bytes;
    };
    const total = width * height;
    const topDown = (desc & 0x20) !== 0;
    let i = 0;
    const put = () => {
        const x = i % width;
        const y = Math.floor(i / width);
        const row = topDown ? y : height - 1 - y;
        out.set(px, (row * width + x) * 4);
        i++;
    };
    while (i < total) {
        if (rle) {
            const h = u8[pos++];
            const count = (h & 127) + 1;
            if (h & 128) {
                read();
                for (let k = 0; k < count && i < total; k++) put();
            } else {
                for (let k = 0; k < count && i < total; k++) {
                    read();
                    put();
                }
            }
        } else {
            read();
            put();
        }
    }
    return { width, height, data: out };
}

function encodeTga(width, height, rgba) {
    const out = new Uint8Array(18 + width * height * 4);
    out[2] = 2;
    out[12] = width & 255;
    out[13] = width >> 8;
    out[14] = height & 255;
    out[15] = height >> 8;
    out[16] = 32;
    out[17] = 0x28; // 8 alpha bits, top-left origin
    for (let i = 0, o = 18; i < width * height; i++, o += 4) {
        out[o] = rgba[i * 4 + 2];
        out[o + 1] = rgba[i * 4 + 1];
        out[o + 2] = rgba[i * 4];
        out[o + 3] = rgba[i * 4 + 3];
    }
    return out;
}

function encodeBmp(width, height, rgba) {
    const size = 54 + width * height * 4;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    out[0] = 66;
    out[1] = 77;
    dv.setUint32(2, size, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, width, true);
    dv.setInt32(22, -height, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 32, true);
    for (let i = 0, o = 54; i < width * height; i++, o += 4) {
        out[o] = rgba[i * 4 + 2];
        out[o + 1] = rgba[i * 4 + 1];
        out[o + 2] = rgba[i * 4];
        out[o + 3] = rgba[i * 4 + 3];
    }
    return out;
}

// ---- DDS ----------------------------------------------------------------

const FOURCC = s => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

export function decodeDds(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== FOURCC('DDS ')) throw new Error('Not a DDS file');
    const height = dv.getUint32(12, true);
    const width = dv.getUint32(16, true);
    const pfFlags = dv.getUint32(80, true);
    const fourCC = dv.getUint32(84, true);
    const bits = dv.getUint32(88, true);
    const masks = [92, 96, 100, 104].map(o => dv.getUint32(o, true));
    let offset = 128;
    let format = null;
    if (pfFlags & 4) {
        if (fourCC === FOURCC('DX10')) {
            const dxgi = dv.getUint32(128, true);
            offset += 20;
            format = { 71: 'BC1', 72: 'BC1', 74: 'BC2', 75: 'BC2', 77: 'BC3', 78: 'BC3', 80: 'BC4', 81: 'BC4', 83: 'BC5', 84: 'BC5', 28: 'RGBA8', 29: 'RGBA8', 87: 'BGRA8', 91: 'BGRA8', 98: 'BC7', 99: 'BC7', 95: 'BC6H', 96: 'BC6H' }[dxgi] ?? 'DXGI ' + dxgi;
        } else {
            format = { [FOURCC('DXT1')]: 'BC1', [FOURCC('DXT2')]: 'BC2', [FOURCC('DXT3')]: 'BC2', [FOURCC('DXT4')]: 'BC3', [FOURCC('DXT5')]: 'BC3', [FOURCC('ATI1')]: 'BC4', [FOURCC('BC4U')]: 'BC4', [FOURCC('ATI2')]: 'BC5', [FOURCC('BC5U')]: 'BC5' }[fourCC] ?? 'FourCC';
        }
    } else if (pfFlags & 0x40 || pfFlags & 0x20000 || pfFlags & 0x2) {
        format = 'MASK';
    }
    const out = new Uint8Array(width * height * 4);
    const src = u8.subarray(offset);
    switch (format) {
        case 'BC1': case 'BC2': case 'BC3': case 'BC4': case 'BC5':
            decodeBlocks(src, width, height, format, out);
            break;
        case 'RGBA8':
            out.set(src.subarray(0, out.length));
            break;
        case 'BGRA8':
            for (let i = 0; i < out.length; i += 4) {
                out[i] = src[i + 2]; out[i + 1] = src[i + 1]; out[i + 2] = src[i]; out[i + 3] = src[i + 3];
            }
            break;
        case 'MASK': {
            const bpp = bits >> 3;
            const shift = m => (m ? Math.log2(m & -m) : 0);
            const scale = m => (m ? 255 / (m >>> shift(m)) : 0);
            for (let i = 0; i < width * height; i++) {
                let v = 0;
                for (let b = 0; b < bpp; b++) v |= src[i * bpp + b] << (8 * b);
                v >>>= 0;
                for (let a = 0; a < 4; a++) {
                    const m = masks[a];
                    out[i * 4 + a] = m ? (((v & m) >>> shift(m)) * scale(m)) : a === 3 ? 255 : (a > 0 && !masks[1] ? out[i * 4] : 0);
                }
            }
            break;
        }
        default:
            return { width, height, data: null, format };
    }
    return { width, height, data: out, format };
}

function decodeBlocks(src, width, height, format, out) {
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const blockSize = format === 'BC1' || format === 'BC4' ? 8 : 16;
    const colors = new Uint8Array(16 * 4);
    const alpha = new Uint8Array(16);
    const second = new Uint8Array(16);
    let o = 0;
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++, o += blockSize) {
            if (format === 'BC4' || format === 'BC5') {
                alphaBlock(src, o, alpha);
                if (format === 'BC5') alphaBlock(src, o + 8, second);
                for (let i = 0; i < 16; i++) {
                    if (format === 'BC4') colors.set([alpha[i], alpha[i], alpha[i], 255], i * 4);
                    else {
                        // Rebuild Z for two-channel normal maps.
                        const x = alpha[i] / 127.5 - 1, y = second[i] / 127.5 - 1;
                        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
                        colors.set([alpha[i], second[i], Math.round((z + 1) * 127.5), 255], i * 4);
                    }
                }
            } else {
                colorBlock(src, format === 'BC1' ? o : o + 8, colors, format === 'BC1');
                if (format === 'BC2') {
                    for (let i = 0; i < 16; i++) colors[i * 4 + 3] = ((src[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
                } else if (format === 'BC3') {
                    alphaBlock(src, o, alpha);
                    for (let i = 0; i < 16; i++) colors[i * 4 + 3] = alpha[i];
                }
            }
            for (let py = 0; py < 4; py++) {
                const y = by * 4 + py;
                if (y >= height) continue;
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    if (x >= width) continue;
                    out.set(colors.subarray((py * 4 + px) * 4, (py * 4 + px) * 4 + 4), (y * width + x) * 4);
                }
            }
        }
    }
}

function colorBlock(src, o, out, bc1) {
    const c0 = src[o] | (src[o + 1] << 8);
    const c1 = src[o + 2] | (src[o + 3] << 8);
    const rgb = c => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
    const a = rgb(c0);
    const b = rgb(c1);
    const pal = [[...a, 255], [...b, 255]];
    if (c0 > c1 || !bc1) {
        pal.push([0, 1, 2].map(k => (2 * a[k] + b[k]) / 3).concat(255));
        pal.push([0, 1, 2].map(k => (a[k] + 2 * b[k]) / 3).concat(255));
    } else {
        pal.push([0, 1, 2].map(k => (a[k] + b[k]) / 2).concat(255));
        pal.push([0, 0, 0, 0]);
    }
    const bits = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
    for (let i = 0; i < 16; i++) out.set(pal[(bits >>> (2 * i)) & 3], i * 4);
}

function alphaBlock(src, o, out) {
    const a0 = src[o];
    const a1 = src[o + 1];
    const pal = [a0, a1];
    if (a0 > a1) for (let k = 1; k < 7; k++) pal.push(((7 - k) * a0 + k * a1) / 7);
    else {
        for (let k = 1; k < 5; k++) pal.push(((5 - k) * a0 + k * a1) / 5);
        pal.push(0, 255);
    }
    let bits = 0n;
    for (let k = 0; k < 6; k++) bits |= BigInt(src[o + 2 + k]) << BigInt(8 * k);
    for (let i = 0; i < 16; i++) out[i] = pal[Number((bits >> BigInt(3 * i)) & 7n)];
}

function encodeDds(width, height, rgba) {
    const out = new Uint8Array(128 + width * height * 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, FOURCC('DDS '), true);
    dv.setUint32(4, 124, true);
    dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x8 | 0x1000, true);
    dv.setUint32(12, height, true);
    dv.setUint32(16, width, true);
    dv.setUint32(20, width * 4, true);
    dv.setUint32(76, 32, true);
    dv.setUint32(80, 0x41, true);
    dv.setUint32(88, 32, true);
    dv.setUint32(92, 0x00ff0000, true);
    dv.setUint32(96, 0x0000ff00, true);
    dv.setUint32(100, 0x000000ff, true);
    dv.setUint32(104, 0xff000000, true);
    dv.setUint32(108, 0x1000, true);
    for (let i = 0, o = 128; i < width * height; i++, o += 4) {
        out[o] = rgba[i * 4 + 2];
        out[o + 1] = rgba[i * 4 + 1];
        out[o + 2] = rgba[i * 4];
        out[o + 3] = rgba[i * 4 + 3];
    }
    return out;
}
