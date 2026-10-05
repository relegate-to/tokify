export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const lookup = new Map([...alphabet].map((c, i) => [c, i]));

// Standard padded base64, matching Go's base64.StdEncoding on both sides of the
// wire. Hand-rolled so it behaves the same under Hermes and Node.
export function toBase64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
        out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : '=';
        out += i + 2 < bytes.length ? alphabet[n & 63] : '=';
    }
    return out;
}

export function fromBase64(text: string): Uint8Array {
    const clean = text.replace(/=+$/, '');
    if (clean.length % 4 === 1) throw new Error('invalid base64');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let bits = 0;
    let acc = 0;
    let j = 0;
    for (const c of clean) {
        const v = lookup.get(c);
        if (v === undefined) throw new Error('invalid base64');
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[j++] = (acc >> bits) & 0xff;
        }
    }
    return out;
}

// Hand-rolled for the same reason, following the WHATWG UTF-8 decoder so
// invalid input yields the same U+FFFD placement as TextDecoder.
export function bytesToUtf8(bytes: Uint8Array): string {
    let out = '';
    let cp = 0;
    let need = 0;
    let seen = 0;
    let lower = 0x80;
    let upper = 0xbf;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (need === 0) {
            if (b < 0x80) out += String.fromCharCode(b);
            else if (b >= 0xc2 && b <= 0xdf) [need, cp] = [1, b & 0x1f];
            else if (b >= 0xe0 && b <= 0xef) {
                if (b === 0xe0) lower = 0xa0;
                if (b === 0xed) upper = 0x9f;
                [need, cp] = [2, b & 0x0f];
            } else if (b >= 0xf0 && b <= 0xf4) {
                if (b === 0xf0) lower = 0x90;
                if (b === 0xf4) upper = 0x8f;
                [need, cp] = [3, b & 0x07];
            } else out += '\ufffd';
            continue;
        }
        if (b < lower || b > upper) {
            [cp, need, seen, lower, upper] = [0, 0, 0, 0x80, 0xbf];
            out += '\ufffd';
            i--; // reprocess this byte as the start of a new sequence
            continue;
        }
        [lower, upper] = [0x80, 0xbf];
        cp = (cp << 6) | (b & 0x3f);
        if (++seen === need) {
            out += String.fromCodePoint(cp);
            [cp, need, seen] = [0, 0, 0];
        }
    }
    return need > 0 ? out + '\ufffd' : out;
}
