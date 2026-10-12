// ASCII FBX reader and writer. Number tokens keep their original text, so
// untouched values are written back exactly as they were read.

export function looksLikeAsciiFbx(text) {
    return /FBXHeaderExtension\s*:/.test(text.slice(0, 4096)) || /^\s*;\s*FBX/m.test(text.slice(0, 1024));
}

export function readAscii(text) {
    const len = text.length;
    let i = 0;

    // The leading comment block ("; FBX 7.4.0 project file") is kept verbatim.
    let headerEnd = 0;
    {
        let j = 0;
        for (;;) {
            while (j < len && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) j++;
            if (text[j] !== ';') break;
            while (j < len && text[j] !== '\n') j++;
            headerEnd = j;
        }
    }
    const header = text.slice(0, headerEnd).replace(/\s+$/, '');

    // Tokens: {k:'key', v} {k:'str', v} {k:'word', v} {k:'count', v} and punctuation , { }
    function next() {
        for (;;) {
            while (i < len) {
                const c = text.charCodeAt(i);
                if (c === 32 || c === 9 || c === 10 || c === 13) i++;
                else break;
            }
            if (i >= len) return null;
            if (text[i] === ';') {
                while (i < len && text[i] !== '\n') i++;
                continue;
            }
            break;
        }
        const c = text[i];
        if (c === ',' || c === '{' || c === '}') {
            i++;
            return { k: c };
        }
        if (c === '"') {
            const end = text.indexOf('"', i + 1);
            if (end < 0) throw new Error('ASCII FBX: unterminated string');
            const v = text.slice(i + 1, end);
            i = end + 1;
            return { k: 'str', v };
        }
        if (c === '*') {
            let j = i + 1;
            while (j < len && /[0-9]/.test(text[j])) j++;
            const v = Number(text.slice(i + 1, j));
            i = j;
            return { k: 'count', v };
        }
        let j = i;
        while (j < len) {
            const d = text[j];
            if (d === ',' || d === '{' || d === '}' || d === '"' || d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === ';') break;
            if (d === ':') break;
            j++;
        }
        const word = text.slice(i, j);
        if (text[j] === ':') {
            i = j + 1;
            return { k: 'key', v: word };
        }
        i = j;
        if (!word.length) throw new Error(`ASCII FBX: unexpected character "${text[i]}" near offset ${i}`);
        return { k: 'word', v: word };
    }

    let look = null;
    const peek = () => (look ??= next());
    const take = () => {
        const t = peek();
        look = null;
        return t;
    };

    function valueToken(t) {
        if (t.k === 'str') return { t: 'S', v: t.v };
        const n = Number(t.v);
        if (t.v.length && !Number.isNaN(n) && /^[-+.0-9]/.test(t.v)) return { t: 'N', v: n, raw: t.v };
        return { t: 'W', v: t.v };
    }

    function readArrayBody() {
        // after "*N {": "a: v, v, v }"
        const key = take();
        if (!key || key.k !== 'key' || key.v !== 'a') throw new Error('ASCII FBX: expected "a:" in an array');
        const start = i;
        let depthEnd = text.indexOf('}', start);
        if (depthEnd < 0) throw new Error('ASCII FBX: unterminated array');
        const raw = text.slice(start, depthEnd).trim();
        i = depthEnd + 1;
        look = null;
        const values = raw.length ? raw.split(',').map(s => Number(s.trim())) : [];
        return { t: 'A', v: Float64Array.from(values), raw };
    }

    function readList(inBlock) {
        const nodes = [];
        for (;;) {
            const t = peek();
            if (!t) {
                if (inBlock) throw new Error('ASCII FBX: missing "}"');
                return nodes;
            }
            if (t.k === '}') {
                if (!inBlock) throw new Error('ASCII FBX: unexpected "}"');
                take();
                return nodes;
            }
            if (t.k !== 'key') throw new Error(`ASCII FBX: expected a name near offset ${i}`);
            take();
            const n = { name: t.v, props: [], children: [], block: false, raw: null, dirty: false };
            const first = peek();
            if (first && first.k === 'count') {
                take();
                const brace = take();
                if (!brace || brace.k !== '{') throw new Error('ASCII FBX: expected "{" after array count');
                n.props.push(readArrayBody());
                n.array = true;
                nodes.push(n);
                continue;
            }
            for (;;) {
                const v = peek();
                if (!v || (v.k !== 'str' && v.k !== 'word')) break;
                take();
                n.props.push(valueToken(v));
                const sep = peek();
                if (sep && sep.k === ',') {
                    take();
                    continue;
                }
                break;
            }
            const after = peek();
            if (after && after.k === '{') {
                take();
                n.block = true;
                n.children = readList(true);
            }
            nodes.push(n);
        }
    }

    const nodes = readList(false);
    const versionNode = nodes.find(n => n.name === 'FBXHeaderExtension')?.children.find(c => c.name === 'FBXVersion');
    let version = versionNode ? Number(versionNode.props[0]?.v) : 0;
    if (!version) {
        const m = /FBX\s+(\d+)\.(\d+)\.(\d+)/.exec(header);
        if (m) version = Number(m[1]) * 1000 + Number(m[2]) * 100 + Number(m[3]) * 10;
    }
    return { format: 'ascii', version, nodes, header };
}

function fmtNumber(v) {
    if (Number.isInteger(v)) return String(v);
    const s = String(v);
    return s;
}

function fmtValue(p) {
    switch (p.t) {
        case 'S': return '"' + String(p.v).replace(/"/g, '&quot;') + '"';
        case 'W': return String(p.v);
        case 'N': return p.raw ?? fmtNumber(p.v);
        case 'C': return p.v ? 'T' : 'F';
        case 'L': return p.v.toString();
        case 'R': return '"' + btoaBytes(p.v) + '"';
        default: return fmtNumber(Number(p.v));
    }
}

function btoaBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'latin1').toString('base64');
}

function arrayText(p) {
    if (p.t === 'A' && p.raw != null) return p.raw;
    const parts = new Array(p.v.length);
    for (let k = 0; k < p.v.length; k++) parts[k] = typeof p.v[k] === 'bigint' ? p.v[k].toString() : fmtNumber(p.v[k]);
    return parts.join(',');
}

export function writeAscii(doc) {
    const out = [];
    if (doc.header) out.push(doc.header, '');
    const isArray = p => p && (p.t === 'A' || p.t === 'f' || p.t === 'd' || p.t === 'i' || p.t === 'l' || p.t === 'b');

    function write(n, indent) {
        const pad = '\t'.repeat(indent);
        const p0 = n.props[0];
        if (n.props.length === 1 && isArray(p0) && (n.array || p0.t !== 'A' || doc.version >= 7000)) {
            out.push(`${pad}${n.name}: *${p0.v.length} {`);
            out.push(`${pad}\ta: ${arrayText(p0)}`);
            out.push(`${pad}} `);
            return;
        }
        let line = `${pad}${n.name}: ` + n.props.map(fmtValue).join(', ');
        if (n.block || n.children.length) {
            line += ' {';
            out.push(n.props.length ? line : `${pad}${n.name}:  {`);
            for (const c of n.children) write(c, indent + 1);
            out.push(`${pad}}`);
        } else {
            out.push(line);
        }
    }

    for (const n of doc.nodes) {
        write(n, 0);
        out.push('');
    }
    return out.join('\n');
}
