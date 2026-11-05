// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* node decode_compare.js <a.yuv> <b.yuv> <w> <h> [every]
 * I420 frames of w x h: a's frame i against b's frame i*every (a decoded
 * with a picture for every `every`th access unit only). Prints one JSON line:
 * frames, how many are equal byte for byte, the lowest PSNR (dB, luma). */
'use strict';
const fs = require('fs');
const [a, b] = [process.argv[2], process.argv[3]].map((f) => fs.readFileSync(f));
const w = Number(process.argv[4]), h = Number(process.argv[5]), every = Number(process.argv[6] || 1);
const size = w * h * 3 / 2;
const na = Math.floor(a.length / size), nb = Math.floor(b.length / size);
let equal = 0, minPsnr = Infinity, n = 0;
for (let i = 0; i < na && i * every < nb; i++, n++) {
    const fa = a.slice(i * size, (i + 1) * size), fb = b.slice(i * every * size, (i * every + 1) * size);
    if (fa.equals(fb)) { equal++; continue; }
    let se = 0;
    for (let k = 0; k < w * h; k++) { const d = fa[k] - fb[k]; se += d * d; }
    const psnr = se ? 10 * Math.log10(255 * 255 / (se / (w * h))) : Infinity;
    if (psnr < minPsnr) minPsnr = psnr;
}
console.log(JSON.stringify({ frames: n, framesA: na, framesB: nb, equal: equal, minPsnr: minPsnr === Infinity ? null : Math.round(minPsnr * 10) / 10 }));
