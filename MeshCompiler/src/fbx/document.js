import { isBinaryFbx, readBinary, writeBinary } from './binary.js';
import { looksLikeAsciiFbx, readAscii, writeAscii } from './ascii.js';

export function readFbx(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let doc;
    if (isBinaryFbx(u8)) {
        doc = readBinary(u8);
    } else {
        const text = new TextDecoder('utf-8').decode(u8);
        if (!looksLikeAsciiFbx(text)) throw new Error('This is not an FBX file.');
        doc = readAscii(text);
    }
    if (doc.version && doc.version < 7000) {
        throw new Error(`FBX ${(doc.version / 1000).toFixed(1)} is too old. Export it again as FBX 2011 (7.1) or newer.`);
    }
    if (!doc.nodes.some(n => n.name === 'Objects')) throw new Error('This FBX has no objects.');
    return doc;
}

export function writeFbx(doc) {
    if (doc.format === 'ascii') return new TextEncoder().encode(writeAscii(doc));
    return writeBinary(doc);
}

// Deep copy so a compile never changes the document it was read from. `map`
// takes a node of the original to its copy.
export function cloneDoc(doc) {
    const map = new Map();
    const copy = n => {
        const c = { ...n, props: n.props.map(p => ({ ...p })), children: n.children.map(copy) };
        map.set(n, c);
        return c;
    };
    return { doc: { ...doc, nodes: doc.nodes.map(copy) }, map };
}
