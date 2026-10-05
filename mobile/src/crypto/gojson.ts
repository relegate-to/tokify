const hex = '0123456789abcdef';

// goString encodes a string exactly as Go's encoding/json does with HTML
// escaping on (json.Marshal's default). Entry ids are HMACs over these bytes,
// so any difference from the desktop splits one activity into two.
export function goString(s: string): string {
    let out = '"';
    for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if (c >= 0xd800 && c <= 0xdfff) {
            // A lone surrogate becomes U+FFFD when encoded as UTF-8, which Go
            // then writes through unescaped.
            out += '�';
            continue;
        }
        switch (ch) {
            case '"':
            case '\\':
                out += '\\' + ch;
                continue;
            case '\b':
                out += '\\b';
                continue;
            case '\f':
                out += '\\f';
                continue;
            case '\n':
                out += '\\n';
                continue;
            case '\r':
                out += '\\r';
                continue;
            case '\t':
                out += '\\t';
                continue;
        }
        if (c < 0x20 || ch === '<' || ch === '>' || ch === '&') {
            out += '\\u00' + hex[c >> 4] + hex[c & 0xf];
        } else if (c === 0x2028 || c === 0x2029) {
            out += '\\u202' + hex[c & 0xf];
        } else {
            out += ch;
        }
    }
    return out + '"';
}

// goObject encodes string and integer fields in the given order, as Go does for
// a struct.
export function goObject(fields: [string, string | number][]): string {
    const parts = fields.map(([k, v]) => goString(k) + ':' + (typeof v === 'number' ? String(v) : goString(v)));
    return '{' + parts.join(',') + '}';
}
