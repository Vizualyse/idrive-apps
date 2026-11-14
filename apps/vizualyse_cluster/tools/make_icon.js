// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The 140x140 tile icon: a white gauge (a 270-degree dial outline, five
 * ticks, a needle and its hub) on transparency, 4x supersampled. A generic
 * shape, no brand's.
 *   node tools/make_icon.js <out.png> */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const N = 140, S = 4, U = S;
const C = 70 * U, R = 56 * U, W = 7 * U;

function segDist(x, y, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
/* angles in degrees, clockwise from the right; the dial runs 135 .. 405 */
const at = (deg, r) => [C + r * Math.cos(deg * Math.PI / 180), C + 6 * U + r * Math.sin(deg * Math.PI / 180)];
function inside(x, y) {
    const cx = C, cy = C + 6 * U, d = Math.hypot(x - cx, y - cy);
    let a = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
    if (a < 135) a += 360;
    /* the dial, round-capped */
    if (Math.abs(d - R) <= W / 2 && a >= 135 && a <= 405) return true;
    for (const end of [135, 405]) { const p = at(end, R); if (Math.hypot(x - p[0], y - p[1]) <= W / 2) return true; }
    /* five ticks inside the dial */
    for (let k = 0; k <= 4; k++) {
        const deg = 135 + k * 67.5, p = at(deg, R - 10 * U), q = at(deg, R - 20 * U);
        if (segDist(x, y, p[0], p[1], q[0], q[1]) <= 2.5 * U) return true;
    }
    /* the needle, towards two o'clock, and its hub */
    const tip = at(320, R - 14 * U);
    if (segDist(x, y, cx, cy, tip[0], tip[1]) <= 3.5 * U) return true;
    return d <= 9 * U;
}

function png(w, h, rgba) {
    const table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (kind, body) => {
        const k = Buffer.from(kind, 'ascii'), len = Buffer.alloc(4), c = Buffer.alloc(4);
        len.writeUInt32BE(body.length, 0); c.writeUInt32BE(crc(Buffer.concat([k, body])), 0);
        return Buffer.concat([len, k, body, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const px = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let n = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inside(x * S + sx + 0.5, y * S + sy + 0.5)) n++;
    const o = (y * N + x) * 4;
    px[o] = px[o + 1] = px[o + 2] = 255; px[o + 3] = Math.round(255 * n / (S * S));
}
fs.writeFileSync(process.argv[2], png(N, N, px));
console.log('icon ' + N + 'x' + N + ' -> ' + process.argv[2]);
