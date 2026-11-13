// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A minimal PNG reader for the theme build: 8-bit RGB or RGBA,
 * non-interlaced (what headless Chrome's screenshots are). Returns
 * { w, h, rgba } with rgba a Buffer of w*h*4 bytes.
 */
'use strict';
const zlib = require('zlib');

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function readPng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
    const idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8);
        const body = buf.slice(off + 8, off + 8 + len);
        if (kind === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
        else if (kind === 'IDAT') idat.push(body);
        else if (kind === 'IEND') break;
        off += 12 + len;
    }
    if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error('unsupported PNG: depth ' + depth + ' type ' + type + ' interlace ' + interlace);
    const bpp = type === 6 ? 4 : 3, stride = w * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(w * h * 4);
    let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
            let v = line[i];
            if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
            cur[i] = v & 255;
        }
        for (let x = 0; x < w; x++) {
            out[(y * w + x) * 4] = cur[x * bpp];
            out[(y * w + x) * 4 + 1] = cur[x * bpp + 1];
            out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
            out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
        }
        const t = prev; prev = cur; cur = t;
    }
    return { w, h, rgba: out };
}

/* An RGBA PNG (for previews and checks), unfiltered, deflated. */
function writePng(w, h, rgba) {
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (kind, body) => {
        const k = Buffer.from(kind, 'ascii'), len = Buffer.alloc(4), c = Buffer.alloc(4);
        len.writeUInt32BE(body.length, 0);
        c.writeUInt32BE(crc(Buffer.concat([k, body])), 0);
        return Buffer.concat([len, k, body, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { readPng, writePng };
