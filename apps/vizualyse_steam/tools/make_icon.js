// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The 140x140 tile icon: a white game controller outline (two grips joined
 * by a body), a d-pad on the left and two buttons on the right, on
 * transparency, 4x supersampled. A generic shape, no brand's.
 *   node tools/make_icon.js <out.png> */
'use strict';
const fs = require('fs');
const { png } = require('../src/qr_png.js');
const N = 140, S = 4, M = N * S, U = M / 140;
const W = 5 * U;   /* line width */

function inBody(x, y) {
    /* a rounded rectangle body with two round grips below its ends */
    const bx0 = 22 * U, bx1 = 118 * U, by0 = 46 * U, by1 = 86 * U, r = 20 * U;
    const cx = Math.max(bx0 + r, Math.min(bx1 - r, x)), cy = Math.max(by0 + r, Math.min(by1 - r, y));
    const inRect = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
    const grip = (gx) => (x - gx) * (x - gx) + (y - 88 * U) * (y - 88 * U) <= (20 * U) * (20 * U);
    return inRect || grip(36 * U) || grip(104 * U);
}
function inside(x, y) {
    /* the outline: in the body, but not a line width inside it */
    const edge = inBody(x, y) && !(inBody(x - W, y) && inBody(x + W, y) && inBody(x, y - W) && inBody(x, y + W));
    if (edge) return true;
    if (!inBody(x, y)) return false;
    /* the d-pad: a plus at (44, 66) */
    const dx = Math.abs(x - 44 * U), dy = Math.abs(y - 66 * U);
    if ((dx <= 3 * U && dy <= 11 * U) || (dy <= 3 * U && dx <= 11 * U)) return true;
    /* two buttons */
    const b = (bx, by) => (x - bx) * (x - bx) + (y - by) * (y - by) <= (5 * U) * (5 * U);
    return b(92 * U, 70 * U) || b(104 * U, 60 * U);
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
