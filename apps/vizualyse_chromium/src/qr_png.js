// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A QR code as a PNG for the page's LT_Label_1Graphic_Scalable: the text at
 * error correction level M (qrcode.js, Kazuhiko Arase, MIT), black on white
 * with the 4-module quiet zone, each module a whole number of pixels so it
 * stays sharp at most maxPx a side. RGBA, deflated. Also png() for the icon.
 */
'use strict';

const zlib = require('zlib');
const qrcode = require('./qrcode.js');

const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    len.writeUInt32BE(data.length, 0);
    crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
}

/* A PNG of w x h RGBA pixels. */
function png(w, h, rgba) {
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* { png, width, modules } of the QR code of `text`. */
function qrPng(text, maxPx) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), m = Math.max(2, Math.floor((maxPx || 360) / (n + 8))), size = (n + 8) * m;
    const px = Buffer.alloc(size * size * 4, 255);
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (!q.isDark(r, c)) continue;
            for (let y = (r + 4) * m; y < (r + 5) * m; y++) {
                for (let x = (c + 4) * m; x < (c + 5) * m; x++) px.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 3);
            }
        }
    }
    return { png: png(size, size, px), width: size, modules: n };
}

module.exports = { qrPng, png, crc32 };
