// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The 140x140 tile icon: a white globe (outline, equator, two parallels, a
 * meridian ellipse and the centre line) on transparency, 4x supersampled.
 *   node tools/make_icon.js <out.png> */
'use strict';
const fs = require('fs');
const { png } = require('../src/qr_png.js');
const N = 140, S = 4, M = N * S;
const R = 0.4 * M, W = 0.035 * M, C = M / 2;
function near(d) { return Math.abs(d) < W / 2; }
function inside(x, y) {
    const dx = x - C, dy = y - C, r = Math.sqrt(dx * dx + dy * dy);
    if (near(r - R)) return true;                       /* the outline */
    if (r > R) return false;
    if (near(dy) || near(dx)) return true;              /* equator, centre meridian */
    if (near(Math.abs(dy) - 0.5 * R) && Math.abs(dx) < Math.sqrt(R * R - 0.25 * R * R)) return true;   /* parallels */
    const e = Math.sqrt(dx * dx / (0.45 * R * 0.45 * R) + dy * dy / (R * R));   /* the meridian ellipse */
    return near((e - 1) * 0.45 * R);
}
const px = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let n = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inside(x * S + sx + 0.5, y * S + sy + 0.5)) n++;
    const a = Math.round(255 * n / (S * S)), o = (y * N + x) * 4;
    px[o] = px[o + 1] = px[o + 2] = 255; px[o + 3] = a;
}
fs.writeFileSync(process.argv[2], png(N, N, px));
console.log('icon ' + N + 'x' + N + ' -> ' + process.argv[2]);
