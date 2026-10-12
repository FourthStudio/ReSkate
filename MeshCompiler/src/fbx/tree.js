// Generic FBX node tree shared by the binary and ASCII readers and writers.
//
// node = { name, props: [{t, v, raw?}], children: [], block, raw?, dirty? }
//   t     binary type code (Y C I F D L f d l i b S R), or for ASCII input
//         N (number token), W (bare word) and A (number array).
//   raw   binary: the node's original property bytes, written back verbatim
//         unless the node is marked dirty. ASCII: a token's original text.
//   block true when the node carries a nested list (and so a null record or
//         braces), even an empty one.

export const ARRAY_TYPES = new Set(['f', 'd', 'l', 'i', 'b', 'A']);

export function node(name, props = [], children = [], block = children.length > 0 || props.length === 0) {
    return { name, props, children, block, raw: null, dirty: true };
}

export const P = {
    i32: v => ({ t: 'I', v }),
    i64: v => ({ t: 'L', v: BigInt(v) }),
    f64: v => ({ t: 'D', v }),
    str: v => ({ t: 'S', v }),
    i32s: v => ({ t: 'i', v: v instanceof Int32Array ? v : Int32Array.from(v) }),
    f64s: v => ({ t: 'd', v: v instanceof Float64Array ? v : Float64Array.from(v) }),
};

export function child(n, name) {
    return n?.children.find(c => c.name === name) ?? null;
}

export function childrenNamed(n, name) {
    return n ? n.children.filter(c => c.name === name) : [];
}

export function num(p) {
    if (!p) return undefined;
    if (p.t === 'L') return Number(p.v);
    if (p.t === 'C') return p.v ? 1 : 0;
    if (p.t === 'W') return p.v === 'T' || p.v === 'Y' ? 1 : p.v === 'F' || p.v === 'N' ? 0 : Number(p.v);
    return typeof p.v === 'number' ? p.v : Number(p.v);
}

export function str(p) {
    if (!p) return '';
    if (p.t === 'S' || p.t === 'W') return String(p.v);
    if (p.t === 'R') return new TextDecoder().decode(p.v);
    return String(p.v);
}

// A stable string key for an object id (int64 in binary, a token in ASCII).
export function idKey(p) {
    if (!p) return '';
    if (p.t === 'L') return p.v.toString();
    if (p.t === 'N') return p.raw ?? String(p.v);
    if (p.t === 'S') return p.v;
    return String(p.v);
}

// The numeric array a node holds: one array property (7.x) or a flat list of
// numbers (ASCII 6.x style).
export function arr(n) {
    if (!n || !n.props.length) return new Float64Array(0);
    const p = n.props[0];
    if (ARRAY_TYPES.has(p.t)) {
        if (p.t === 'l') return Float64Array.from(p.v, Number);
        return p.v;
    }
    return Float64Array.from(n.props, num);
}

export function childArr(n, name) {
    return arr(child(n, name));
}

// "Name\0\1Class" (binary) or "Class::Name" (ASCII) to "Name".
export function objectName(p) {
    const s = str(p);
    const bin = s.indexOf('\u0000\u0001');
    if (bin >= 0) return s.slice(0, bin);
    const ascii = s.indexOf('::');
    return ascii >= 0 ? s.slice(ascii + 2) : s;
}

// Properties70 / Properties60 as name -> value list.
export function properties(n) {
    const out = new Map();
    const block = child(n, 'Properties70') ?? child(n, 'Properties60');
    if (!block) return out;
    const valueStart = block.name === 'Properties70' ? 4 : 3;
    for (const p of block.children) {
        if (p.name !== 'P' && p.name !== 'Property') continue;
        const key = str(p.props[0]);
        const values = p.props.slice(valueStart).map(v => (v.t === 'S' ? v.v : num(v)));
        out.set(key, values);
    }
    return out;
}

export function markDirty(n) {
    n.dirty = true;
    n.raw = null;
}
