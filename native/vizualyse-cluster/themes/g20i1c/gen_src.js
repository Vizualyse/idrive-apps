// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for g20i1c "G20 inspired 1 · Comfort" (the g20i1
 * family's Comfort mode, shader library v2) from the G20 Comfort mockup's
 * geometry: the Sport theme's brackets, bars and mini bars (see
 * themes/g20i1/gen_src.js), with the Comfort readings.
 *   node themes/g20i1c/gen_src.js
 * then node tools/theme_build.js themes/g20i1c
 *
 * Fields: the speedometer's bracket (the tach mirrors it; a second layer on
 * it draws the cruise set-speed pointer outside the outline), the fuel bar
 * (the oil bar mirrors it), the economy and electric-power bars.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { flatten, measure } = require('../../tools/field.js');

const R = (v) => Math.round(v * 100) / 100;
function unit(x, y) { const m = Math.hypot(x, y) || 1; return [x / m, y / m]; }
function len(pieces) { const c = measure(flatten(pieces)); return c[c.length - 1]; }

/* The mockup's roundedPath(pts, 70) as path pieces, trimmed to the scale */
function bracket(pts, startAt, endPad) {
    const r = 70, pieces = [];
    const d0 = unit(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    pieces.push(['L', R(pts[0][0] + d0[0] * startAt), R(pts[0][1] + d0[1] * startAt)]);
    for (let i = 1; i < pts.length - 1; i++) {
        const p = pts[i], a = unit(pts[i - 1][0] - p[0], pts[i - 1][1] - p[1]), b = unit(pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]);
        pieces.push(['L', R(p[0] + a[0] * r), R(p[1] + a[1] * r)]);
        pieces.push(['Q', p[0], p[1], R(p[0] + b[0] * r), R(p[1] + b[1] * r)]);
    }
    const n = pts.length, dl = unit(pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]);
    pieces.push(['L', R(pts[n - 1][0] - dl[0] * endPad), R(pts[n - 1][1] - dl[1] * endPad)]);
    return pieces;
}
function mini(a, b, out) {
    const A = [a[0] + out[0] * 36, a[1] + out[1] * 36], B = [b[0] + out[0] * 36, b[1] + out[1] * 36];
    const along = (k) => [R(A[0] + (B[0] - A[0]) * k), R(A[1] + (B[1] - A[1]) * k)];
    return { p0: along(0.14), p1: along(0.84) };
}

/* speed: a 70 px lead-in along the outline (never lit), then the scale */
const SPEED_PTS = [[690, 560], [300, 560], [120, 330], [270, 96], [720, 70]];
const scale = bracket(SPEED_PTS, 290, 40);
const start = scale[0];
const speedPath = [['M', start[1] + 70, start[2]]].concat(scale);
const total = len(speedPath);
const t0 = Math.round(70 / total * 1e6) / 1e6;

/* the field reaches 26 px outside the outline for the set-speed pointer
 * (7..23 px out); the glow has no outward reach */
const OUT = 26;
const pts = flatten(speedPath);
const bx = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
const by = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
const speedRect = [Math.floor(bx[0] - OUT), Math.max(0, Math.floor(by[0] - OUT)), 0, 0];
speedRect[2] = Math.ceil(bx[1] + 10) - speedRect[0];
speedRect[3] = Math.min(645, Math.ceil(by[1] + OUT)) - speedRect[1];

/* Comfort's quieter wedge: 84 px deep at peak 0.3 (Sport: 112, 0.5) */
const GLOW = 130, TRAIL = 70;

const fuel = mini([300, 560], [120, 330], [-0.788, 0.616]);
const FUEL = [['M', fuel.p0[0], fuel.p0[1]], ['L', fuel.p1[0], fuel.p1[1]]];
const fuelRect = [Math.floor(Math.min(fuel.p0[0], fuel.p1[0]) - 6), Math.floor(Math.min(fuel.p0[1], fuel.p1[1]) - 6), 0, 0];
fuelRect[2] = Math.ceil(Math.max(fuel.p0[0], fuel.p1[0]) + 6) - fuelRect[0];
fuelRect[3] = Math.ceil(Math.max(fuel.p0[1], fuel.p1[1]) + 6) - fuelRect[1];

const ECO = [['M', 800, 420], ['Q', 762, 270, 800, 120]];
const PWR = [['M', 1120, 420], ['Q', 1158, 270, 1120, 120]];
const barLen = len(ECO);

const C = {
    calm: [0.851, 0.525, 0.275], limit: [1, 0.169, 0.11], ember: [0.29, 0.157, 0.078], volt: [0.302, 0.722, 1],
    ink: [0.965, 0.937, 0.91], line: [1, 0.824, 0.678], dim: [0.659, 0.616, 0.584], track: [0.173, 0.149, 0.141],
};
const a = (c, al) => c.concat([al]);

/* fonts: proportional; baseline at bl px from the cell's top:
 * (h - 1.2 size) / 2 + size + dy */
const F400 = '../fonts/BarlowSemiCondensed-400.woff2', F500 = '../fonts/BarlowSemiCondensed-500.woff2', F600 = '../fonts/BarlowSemiCondensed-600.woff2';
const fonts = {
    big: { file: F500, weight: 500, size: 170, cell: [110, 136], dy: -8, tracking: -3.4, glyphs: '0123456789 -DMSPRN', bl: 128 },
    val: { file: F500, weight: 500, size: 30, cell: [24, 28], dy: -2, glyphs: '0123456789 -+.:/', bl: 24 },
    label: { file: F500, weight: 500, size: 22, cell: [20, 20], dy: -0.8, tracking: 1.32, glyphs: 'ACEGHILNRT -dimy', bl: 18 },
    gearNum: { file: F400, weight: 400, size: 64, cell: [36, 52], dy: -1.6, glyphs: '0123456789 -', bl: 50 },
    dist: { file: F500, weight: 500, size: 38, cell: [24, 36], dy: -1.2, glyphs: '0123456789 -.', bl: 32 },
    limit: { file: F600, weight: 600, size: 36, cell: [24, 40], dy: -0.4, glyphs: '0123456789 -', bl: 34 },
    road: { file: F500, weight: 500, size: 26, cell: [26, 30], dy: -1.4, bl: 24,
        glyphs: " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'.&/" },
};
function text(name, font, cells, w, x, y, align, color) {
    const f = fonts[font];
    const lx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    return { name, shader: 'text', font, x: Math.round(lx), y: Math.round(y - f.bl), w, cells, align, uniforms: { u_color: color || a(C.ink, 1) } };
}
function rect(name, x, y, w, h, r, color) {
    return { name, shader: 'rect', x, y, w, h, uniforms: { u_shape: [0, 0, r, 0], u_color: color } };
}
const off = [0, 0, 0, 0];

/* the bracket gauges: band 22 px wide 16 px inside the outline (d 5..27) in
 * segments whose gaps fall on the ticks, copper at 0.66; a 5 px needle; the
 * copper wedge (linear falloff) added to the art, brightening the numerals;
 * a weak copper pool at the needle for the mockup's needle heat (0.4) */
const bracketU = (segs) => ({
    u_v: [t0, 0, 2, R(TRAIL / total)], u_band: [5, 27, 0, 40], u_shape: [GLOW, 2.5, 2.5, 0],
    u_fill: a(C.calm, 0.66), u_red: a(C.calm, 0.66), u_glow: a(C.calm, 0), u_needle: a(C.ink, 1),
    u_seg: [segs, 2.5, t0, 1], u_pool: [14, 0.6, 20, 0], u_look: [0, 3, 1, 0],
});
/* the cruise set-speed pointer: a needle 7..23 px outside the outline, 18 px
 * wide at its outer end and pointed at its inner one (the mockup's triangle) */
const pointerU = () => ({
    u_v: [t0, 0, 2, 0], u_band: [-23, -7, -23, -7], u_shape: [1, 9, 0, 0],
    u_fill: off, u_red: off, u_glow: off, u_needle: a(C.ink, 0), u_seg: [0, 0, t0, 1], u_look: [0, 0, 1, 0],
});
const barU = (fill, startT) => ({
    u_v: [startT, 0, 2, 0], u_band: [-7, 7, 0, 0], u_shape: [1, 0, 0, 0],
    u_fill: fill, u_red: fill, u_glow: off, u_needle: off, u_seg: [0, 0, startT, 1], u_look: [0, 0, 1, 0],
});
const miniU = () => ({
    u_v: [0, 0, 2, 0], u_band: [-3.5, 3.5, 0, 0], u_shape: [1, 0, 0, 0],
    u_fill: a(C.line, 1), u_red: a(C.line, 1), u_glow: off, u_needle: off, u_seg: [0, 0, -0.03, 1], u_look: [0, 0, 1, 0],
});
const BLACK = [0, 0, 0, 1];

const layers = [
    { name: 'speed', shader: 'gauge', field: 'speed', uniforms: bracketU(16) },
    { name: 'tach', shader: 'gauge', field: 'tach', uniforms: bracketU(14) },
    { name: 'setPointer', shader: 'gauge', field: 'speed', art: false, uniforms: pointerU() },
    { name: 'fuel', shader: 'gauge', field: 'fuel', art: false, uniforms: miniU() },
    { name: 'oil', shader: 'gauge', field: 'oil', art: false, uniforms: miniU() },
    { name: 'eco', shader: 'gauge', field: 'eco', art: false, uniforms: barU(a(C.line, 1), -0.01) },
    { name: 'power', shader: 'gauge', field: 'power', art: false, uniforms: barU(a(C.volt, 1), 0.25) },
    /* the turn arrows (art) share their stem: cover the half not in use,
     * or all three parts when there is no manoeuvre */
    rect('turnCoverL', 758, 16, 33, 32, 0, BLACK),
    rect('turnCoverR', 797, 16, 34, 32, 0, BLACK),
    rect('turnCoverStem', 789, 30, 10, 40, 0, BLACK),
    /* cruise off: the mockup drops the unit after the dim dashes */
    rect('cruiseUnitCover', 615, 410, 46, 26, 0, BLACK),
    { name: 'socCells', shader: 'leds', x: 798, y: 536, w: 323, h: 13,
      uniforms: { u_led: [20, 0, 0, 0], u_geom: [0, 0, 13, 9], u_split: [99, 99, 0, 0],
                  u_c0: a(C.volt, 1), u_c1: a(C.volt, 1), u_c2: a(C.volt, 1), u_off: a(C.track, 1) } },
    text('speedText', 'big', 3, 270, 640, 350, 'right'),
    text('gearText', 'big', 1, 110, 1262, 350, 'left'),
    text('gearNum', 'gearNum', 2, 72, 1378, 350, 'left', a(C.dim, 1)),
    text('limitText', 'limit', 3, 60, 412, 434, 'center'),
    text('cruiseText', 'val', 3, 60, 610, 430, 'right'),
    text('rpmText', 'val', 4, 80, 1296, 414, 'right'),
    text('avgText', 'val', 4, 70, 1476, 414, 'right'),
    text('distText', 'dist', 4, 80, 914, 60, 'right'),
    text('distUnit', 'label', 2, 30, 922, 60, 'left', a(C.dim, 1)),
    text('roadText', 'road', 16, 300, 972, 59, 'left'),
    text('ecoText', 'val', 3, 60, 800, 458, 'right'),
    text('powerText', 'val', 3, 60, 1122, 458, 'right'),
    text('powerLabel', 'label', 8, 130, 1120, 486, 'center', a(C.dim, 1)),
    text('etaText', 'val', 5, 80, 890, 425, 'left'),
    text('toGoText', 'val', 5, 80, 1056, 425, 'right'),
    text('socText', 'val', 3, 50, 1022, 525, 'right'),
    text('evRangeText', 'val', 3, 50, 1090, 525, 'right'),
    text('rangeText', 'val', 4, 60, 282, 616, 'right'),
    text('clockText', 'val', 5, 80, 390, 616, 'left'),
    text('tripText', 'val', 6, 90, 650, 616, 'right'),
    text('tyresText', 'val', 7, 90, 1306, 616, 'left'),
    text('outsideText', 'val', 5, 80, 1540, 616, 'right'),
    text('oilText', 'val', 3, 60, 1656, 616, 'right'),
];

const src = {
    id: 'g20i1c',
    title: 'G20 inspired 1 · Comfort',
    family: 'g20i1',
    mode: 'comfort',
    version: 2,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm', 'oilC', 'tyres', 'outsideC',
        'clock', 'tripKm', 'avgL100', 'instL100', 'limitKmh', 'cruiseKmh', 'turnDir', 'turnM', 'road', 'destKm', 'eta'],
    params: {
        maxMph: 160, maxKrpm: 7, glow: 0.65,
        ecoMaxMpg: 99, powerMaxKw: 60, chargeMaxKw: 30,
        gauge: { len: R(total), t0, t1: 1 },
        bar: { len: R(barLen), zero: 0.25, gap: R(2 / barLen) },
        colors: C,
    },
    fonts: Object.keys(fonts).reduce((o, k) => { const f = Object.assign({}, fonts[k]); delete f.bl; o[k] = f; return o; }, {}),
    paths: {
        speed: { path: speedPath, inward: -1, rect: speedRect, maxd: 112 },
        tach: { mirror: 'speed' },
        fuel: { path: FUEL, inward: 1, rect: fuelRect, maxd: 6, ends: true },
        oil: { mirror: 'fuel' },
        eco: { path: ECO, inward: 1, rect: [772, 117, 38, 306], maxd: 9 },
        power: { path: PWR, inward: 1, rect: [1110, 117, 38, 306], maxd: 9 },
    },
    layers,
};
fs.writeFileSync(path.join(__dirname, 'theme.src.json'), JSON.stringify(src, null, 1) + '\n');
console.log('speed path', R(total), 'px, scale from t', t0, ', rect', speedRect.join(' '), '; fuel rect', fuelRect.join(' '));
