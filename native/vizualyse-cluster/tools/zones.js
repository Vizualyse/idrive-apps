// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The car's panel shape (theme_core.PANEL, measured on the car) laid over a
 * 1920 x 720 screenshot: the gear window cyan, the warning lights' and gear
 * plate's keep-out zones magenta, the top corners the glass cuts off red. A
 * moving part in any of them fails theme_build (theme_core.check).
 *   node tools/zones.js <in.png> <out.png>
 *   node tools/zones.js --blank <out.png>      the zones on black
 */
'use strict';
const fs = require('fs');
const { readPng, writePng } = require('./png.js');
const { PANEL } = require('../src/theme_core.js');

const args = process.argv.slice(2);
if (args.length !== 2) { console.error('usage: node tools/zones.js <in.png>|--blank <out.png>'); process.exit(2); }
const W = 1920, H = 720;
let img;
if (args[0] === '--blank') img = { w: W, h: H, rgba: Buffer.alloc(W * H * 4) };
else img = readPng(fs.readFileSync(args[0]));
if (img.w !== W || img.h < 646) { console.error('expected a 1920-wide screenshot, got ' + img.w + 'x' + img.h); process.exit(2); }
const h = img.h, px = img.rgba;
if (args[0] === '--blank') for (let i = 3; i < px.length; i += 4) px[i] = 255;

function tint(x, y, c, a) {
    if (x < 0 || y < 0 || x >= W || y >= h) return;
    const i = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - a) + c[k] * a);
}
function rect(r, c) {
    for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) {
        const edge = y === r[1] || y === r[1] + r[3] - 1 || x === r[0] || x === r[0] + r[2] - 1;
        tint(x, y, c, edge ? 1 : 0.35);
    }
}
PANEL.keepOut.forEach((k) => rect(k.r, [255, 0, 220]));
rect(PANEL.gearWindow, [0, 230, 255]);
const L = PANEL.corners.left, R = PANEL.corners.right;
for (let y = 0; y < Math.max(L[1], R[1]); y++) for (let x = 0; x < W; x++) {
    const inL = x / L[0] + y / L[1] < 1, inR = (W - 1 - x) / R[0] + y / R[1] < 1;
    if (inL || inR) tint(x, y, [255, 30, 30], 0.45);
}
fs.writeFileSync(args[1], writePng(W, h, px));
console.log(args[1]);
