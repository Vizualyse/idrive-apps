// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The 140x140 tile icon: a white crescent moon with a play triangle in its
 * hollow, on transparency, 4x supersampled.  node tools/make_icon.js <out.png> */
'use strict';
const fs = require('fs');
const { png } = require('../src/qr_png.js');
const N = 140, S = 4, M = N * S;
function inside(x, y) {
    /* the crescent: a disc less an offset disc */
    const dx = x - 0.46 * M, dy = y - 0.5 * M, ex = x - 0.62 * M, ey = y - 0.42 * M;
    if (dx * dx + dy * dy < Math.pow(0.36 * M, 2) && ex * ex + ey * ey > Math.pow(0.3 * M, 2)) return true;
    /* the play triangle in the hollow */
    const tx = x - 0.56 * M, ty = y - 0.44 * M, h = 0.13 * M, w = 0.2 * M;
    return tx >= 0 && tx <= w && Math.abs(ty) <= h * (1 - tx / w);
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
