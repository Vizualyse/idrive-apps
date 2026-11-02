// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The 140x140 tile icon: a white play triangle with a "cast" arc, on
 * transparency, 4x supersampled.  node tools/make_icon.js <out.png> */
'use strict';
const fs = require('fs');
const { png } = require('../src/qr_png.js');
const N = 140, S = 4, M = N * S;
function inside(x, y) {
    const cx = M / 2, cy = M / 2;
    /* the play triangle */
    const tx = x - (cx - 0.18 * M), ty = y - cy, h = 0.26 * M;
    if (tx >= 0 && tx <= 0.42 * M && Math.abs(ty) <= h * (1 - tx / (0.42 * M))) return true;
    /* two cast arcs at the lower left */
    const ax = x - 0.16 * M, ay = y - 0.84 * M, r = Math.sqrt(ax * ax + ay * ay);
    if (ax >= 0 && ay <= 0 && ((r > 0.09 * M && r < 0.13 * M) || (r > 0.18 * M && r < 0.22 * M))) return true;
    return r < 0.045 * M;
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
