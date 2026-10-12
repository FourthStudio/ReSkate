// Binary FBX (7.x) reader and writer. Untouched nodes keep their original
// property bytes, so a file read and written back without changes comes out
// byte for byte the same (apart from a footer rebuilt the standard way).
import { unzlibSync, zlibSync } from 'three/examples/jsm/libs/fflate.module.js';

const MAGIC = 'Kaydara FBX Binary  \u0000';
const FOOTER_ID = Uint8Array.from([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
const FOOTER_MAGIC = Uint8Array.from([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);
const COMPRESS_OVER = 128;

export function isBinaryFbx(u8) {
    if (u8.length < 27) return false;
    for (let i = 0; i < MAGIC.length; i++) if (u8[i] !== MAGIC.charCodeAt(i)) return false;
    return true;
}

export function readBinary(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const version = dv.getUint32(23, true);
    const wide = version >= 7500;
    const nullLen = wide ? 25 : 13;
    let compressed = false;
    let pos = 27;

    const u = () => {
        let v;
        if (wide) {
            v = Number(dv.getBigUint64(pos, true));
            pos += 8;
        } else {
            v = dv.getUint32(pos, true);
            pos += 4;
        }
        return v;
    };

    function readArray(type) {
        const length = dv.getUint32(pos, true);
        const encoding = dv.getUint32(pos + 4, true);
        const byteLen = dv.getUint32(pos + 8, true);
        pos += 12;
        let bytes = u8.subarray(pos, pos + byteLen);
        pos += byteLen;
        if (encoding === 1) {
            compressed = true;
            bytes = unzlibSync(bytes);
        } else {
            bytes = bytes.slice();
        }
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        switch (type) {
            case 'f': return new Float32Array(buf, 0, length);
            case 'd': return new Float64Array(buf, 0, length);
            case 'l': return new BigInt64Array(buf, 0, length);
            case 'i': return new Int32Array(buf, 0, length);
            case 'b': return new Uint8Array(buf, 0, length);
        }
        throw new Error('Unknown FBX array type ' + type);
    }

    function readProp() {
        const t = String.fromCharCode(u8[pos++]);
        let v;
        switch (t) {
            case 'Y': v = dv.getInt16(pos, true); pos += 2; break;
            case 'C': v = u8[pos] !== 0; pos += 1; break;
            case 'I': v = dv.getInt32(pos, true); pos += 4; break;
            case 'F': v = dv.getFloat32(pos, true); pos += 4; break;
            case 'D': v = dv.getFloat64(pos, true); pos += 8; break;
            case 'L': v = dv.getBigInt64(pos, true); pos += 8; break;
            case 'S': {
                const len = dv.getUint32(pos, true);
                pos += 4;
                v = latin1(u8.subarray(pos, pos + len));
                pos += len;
                break;
            }
            case 'R': {
                const len = dv.getUint32(pos, true);
                pos += 4;
                v = u8.slice(pos, pos + len);
                pos += len;
                break;
            }
            case 'f': case 'd': case 'l': case 'i': case 'b':
                v = readArray(t);
                break;
            default:
                throw new Error(`Corrupt FBX: unknown property type "${t}" at byte ${pos - 1}`);
        }
        return { t, v };
    }

    function readNode() {
        const start = pos;
        const end = u();
        const count = u();
        const propLen = u();
        const nameLen = u8[pos++];
        if (end === 0) {
            if (count !== 0 || propLen !== 0 || nameLen !== 0) throw new Error('Corrupt FBX: bad null record at byte ' + start);
            return null;
        }
        const name = latin1(u8.subarray(pos, pos + nameLen));
        pos += nameLen;
        const propStart = pos;
        const props = [];
        for (let i = 0; i < count; i++) props.push(readProp());
        if (pos !== propStart + propLen) throw new Error(`Corrupt FBX: property size mismatch in ${name}`);
        const n = { name, props, children: [], block: false, raw: u8.subarray(propStart, propStart + propLen), dirty: false };
        if (pos < end) {
            n.block = true;
            for (;;) {
                const c = readNode();
                if (!c) break;
                n.children.push(c);
            }
        }
        if (pos !== end) throw new Error(`Corrupt FBX: node ${name} ends at ${pos}, expected ${end}`);
        return n;
    }

    const nodes = [];
    while (pos + nullLen <= u8.length) {
        const c = readNode();
        if (!c) break;
        nodes.push(c);
    }

    let footerId = FOOTER_ID;
    const tail = u8.subarray(pos);
    const hasFooter = tail.length >= 16;
    if (hasFooter) footerId = tail.slice(0, 16);

    return { format: 'binary', version, nodes, footerId, hasFooter, compressed };
}

function latin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return s;
}

function latin1Bytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out[i] = c < 256 ? c : 63;
    }
    return out;
}

function encodeProps(props, compress) {
    const parts = [];
    let total = 0;
    const push = b => {
        parts.push(b);
        total += b.length;
    };
    for (const p of props) {
        const head = new Uint8Array([p.t.charCodeAt(0)]);
        push(head);
        let b;
        switch (p.t) {
            case 'Y': b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, p.v, true); break;
            case 'C': b = new Uint8Array([p.v ? 1 : 0]); break;
            case 'I': b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, p.v, true); break;
            case 'F': b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, p.v, true); break;
            case 'D': b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, p.v, true); break;
            case 'L': b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(p.v), true); break;
            case 'S': case 'R': {
                const data = p.t === 'S' ? latin1Bytes(p.v) : p.v;
                b = new Uint8Array(4 + data.length);
                new DataView(b.buffer).setUint32(0, data.length, true);
                b.set(data, 4);
                break;
            }
            case 'f': case 'd': case 'l': case 'i': case 'b': {
                const raw = new Uint8Array(p.v.buffer, p.v.byteOffset, p.v.byteLength);
                const zip = compress && raw.length > COMPRESS_OVER;
                const data = zip ? zlibSync(raw, { level: 6 }) : raw;
                b = new Uint8Array(12 + data.length);
                const dv = new DataView(b.buffer);
                dv.setUint32(0, p.v.length, true);
                dv.setUint32(4, zip ? 1 : 0, true);
                dv.setUint32(8, data.length, true);
                b.set(data, 12);
                break;
            }
            default:
                throw new Error(`Cannot write property type "${p.t}" to a binary FBX`);
        }
        push(b);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const b of parts) {
        out.set(b, o);
        o += b.length;
    }
    return out;
}

export function writeBinary(doc) {
    const wide = doc.version >= 7500;
    const nullLen = wide ? 25 : 13;
    const headLen = wide ? 25 : 13; // offsets + name length byte
    const compress = doc.compressed !== false;

    function prep(n) {
        n._name = latin1Bytes(n.name);
        n._props = !n.dirty && n.raw ? n.raw : encodeProps(n.props, compress);
        let size = headLen + n._name.length + n._props.length;
        for (const c of n.children) size += prep(c);
        if (n.block || n.children.length) size += nullLen;
        n._size = size;
        return size;
    }

    let body = 0;
    for (const n of doc.nodes) body += prep(n);
    const nodesEnd = 27 + body + nullLen;
    const footerStart = nodesEnd + 16 + 4;
    let pad = ((footerStart + 15) & ~15) - footerStart;
    if (pad === 0) pad = 16;
    const total = doc.hasFooter === false ? nodesEnd : footerStart + pad + 4 + 120 + 16;

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
    out[21] = 0x1a;
    out[22] = 0x00;
    dv.setUint32(23, doc.version, true);
    let pos = 27;

    const putU = v => {
        if (wide) {
            dv.setBigUint64(pos, BigInt(v), true);
            pos += 8;
        } else {
            dv.setUint32(pos, v, true);
            pos += 4;
        }
    };

    function write(n) {
        const start = pos;
        putU(start + n._size);
        putU(n.props.length);
        putU(n._props.length);
        out[pos++] = n._name.length;
        out.set(n._name, pos);
        pos += n._name.length;
        out.set(n._props, pos);
        pos += n._props.length;
        for (const c of n.children) write(c);
        if (n.block || n.children.length) pos += nullLen;
        delete n._name;
        delete n._props;
        delete n._size;
    }

    for (const n of doc.nodes) write(n);
    pos += nullLen;
    if (doc.hasFooter !== false) {
        out.set(doc.footerId ?? FOOTER_ID, pos);
        pos += 16 + 4 + pad;
        dv.setUint32(pos, doc.version, true);
        pos += 4 + 120;
        out.set(FOOTER_MAGIC, pos);
    }
    return out;
}
