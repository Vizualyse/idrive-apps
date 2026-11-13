// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for g20i2c ("G20 inspired 2 · Comfort"), the Comfort
 * theme of the g20i2 family, from the Sport theme's geometry (themes/g20i2/
 * gen.js): the same frames, scales, bars and fuel arc; an amber wake with a
 * linear falloff, the speed limit's tick and the cruise set mark, the drive
 * and economy meters on the power bars, the turn arrows, no shift lamps.
 *   node themes/g20i2c/gen.js
 */
'use strict';
const G = require('../g20i2/gen.js');
const { lerp, LEFT, S0, S1, off, bbox, lengthOf, stops, hex, SPEED_MAP, speedPath, speedRect, SPEED_T0, barPath, barT, barRect,
    fuelPath, fuelRect, writeSpec } = G;

/* ---- the next manoeuvre's arrow, right and left (mirrored about x 869); round ends ---- */
const arrowR = [['M', 852, 498], ['L', 852, 470], ['Q', 852, 460, 862, 460], ['L', 886, 460], ['L', 874, 448], ['L', 886, 460], ['L', 874, 472]];
const arrowL = arrowR.map((p) => p[0] === 'Q' ? ['Q', 1738 - p[1], p[2], 1738 - p[3], p[4]] : [p[0], 1738 - p[1], p[2]]);

/* ---- the cruise set mark: a dot 28 px outside the speed frame, positions every 5 mph ---- */
const setPos = [];
for (let v = 0; v <= 160; v += 5) {
    const q = off(LEFT, lerp(S0, S1, stops(SPEED_MAP, v)), -28);
    setPos.push([Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]);
}

/* ---- fonts: Barlow Semi Condensed; baseline at h/2 + 0.4 size + dy in a cell ---- */
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', az = 'abcdefghijklmnopqrstuvwxyz';
const FONTS = {
    speed: { size: 156, cell: [80, 124], dy: -6, glyphs: '0123456789 -' },
    big: { size: 120, cell: [80, 100], dy: -2, glyphs: 'DMSNRP-' },
    f35: { size: 35, cell: [30, 40], dy: 0, glyphs: '0123456789 .-ydmiEVN' },
    mid: { size: 26, cell: [22, 30], dy: 0, glyphs: '0123456789 -−+.:%°Cmi' },
    small: { size: 19, cell: [18, 24], dy: 0, glyphs: '0123456789 -.:·°+' + AZ + az },
    cap: { size: 16, cell: [18, 20], dy: 0, weight: 600, tracking: 1.92, glyphs: 'ECOPWRHAGD %0123456789-' },
};
const base = (f) => FONTS[f].cell[1] / 2 + 0.4 * FONTS[f].size + FONTS[f].dy;
function text(name, font, cells, align, bx, by, w, color) {
    const x = align === 'right' ? bx - w : align === 'center' ? bx - w / 2 : bx;
    const l = { name, shader: 'text', font, x: Math.round(x), y: Math.round(by - base(font)), w: Math.round(w), cells, align };
    if (color) l.uniforms = { u_color: color };
    return l;
}
const C = {
    ink: hex('#f1f0ec'), ink2: hex('#b4b2ac'), ink3: hex('#8a8882'), ink4: hex('#3a3936'), sport: hex('#ff3a1c'),
    needle: hex('#ffc88a'), calm: hex('#f0a550'), edrive: hex('#3aa2ff'), regen: hex('#9fd2ff'), none: [0, 0, 0, 0],
};

/* the amber wake: the mockup's bands reach 88 px in, then an 8 px blur; a linear falloff, about half Sport's light */
const GLOW = 100, TRAIL = 300;
const L = lengthOf(speedPath);
const gaugeU = {
    u_v: [0, 0, 2, +(TRAIL / L).toFixed(4)], u_band: [0, 0, 2, 36], u_shape: [GLOW, 4.5, 2, 0.15],
    u_fill: C.none, u_red: C.none, u_glow: [1, 0.66, 0.3, 0.42], u_needle: C.needle,
    u_pool: [100, 0.3, 30, 0], u_seg: [0, 0, SPEED_T0, 1], u_look: [0.3, 0.25, 1, 0],
};
const bandU = (b, fill, seg) => ({
    u_v: [0, 0, 2, 1], u_band: [-b, b, 0, 0], u_shape: [1, 0, 0, 1],
    u_fill: fill, u_red: fill, u_glow: C.none, u_needle: C.none, u_seg: seg || [0, 0, 0, 1],
});
const PWR_ZERO = 0.2;
const driveZero = +lerp(barT.eng0, barT.eng1, PWR_ZERO).toFixed(5);
const layers = [
    { name: 'speed', shader: 'gauge', field: 'speed', uniforms: gaugeU },
    { name: 'tach', shader: 'gauge', field: 'tach', uniforms: gaugeU },
    /* the speed limit: a red tick 5..17 px outside the frame (the needle of a second layer on the speed field) */
    { name: 'limitTick', shader: 'gauge', field: 'speed', art: false, uniforms: {
        u_v: [0, 0, 2, 0], u_band: [0, 0, -17, -5], u_shape: [1, 1.75, 1.75, 0],
        u_fill: C.none, u_red: C.none, u_glow: C.none, u_needle: C.sport, u_seg: [0, 0, 0, 1], u_look: [0, 0, 1, 0] } },
    { name: 'drive', shader: 'gauge', field: 'bars', art: false, uniforms: bandU(11, C.calm, [0, 0, driveZero, 1]) },
    { name: 'econ', shader: 'gauge', field: 'bars', art: false, uniforms: bandU(11, C.ink2, [0, 0, barT.eleBottom, 1]) },
    { name: 'fuel', shader: 'gauge', field: 'fuel', art: false, uniforms: bandU(3.5, C.ink) },
    { name: 'arrowR', shader: 'gauge', field: 'arrowR', art: false, uniforms: Object.assign(bandU(2.5, C.ink), { u_v: [1, 0, 2, 1] }) },
    { name: 'arrowL', shader: 'gauge', field: 'arrowL', art: false, uniforms: Object.assign(bandU(2.5, C.ink), { u_v: [1, 0, 2, 1] }) },
    { name: 'soc', shader: 'leds', x: 482, y: 447, w: 220, h: 16, uniforms: {
        u_led: [20, 0, 0, 0], u_geom: [0, 0, 7.5, 16], u_split: [99, 99, 0, 1],
        u_c0: C.edrive, u_c1: C.edrive, u_c2: C.edrive, u_off: C.ink4 } },
    { name: 'oilMark', shader: 'rect', x: 1800, y: 430, w: 20, h: 7, uniforms: { u_shape: [0, 0, 0, 0], u_color: C.ink } },
    { name: 'setMark', shader: 'rect', x: 0, y: 0, w: 10, h: 10, uniforms: { u_shape: [0, 0, 5, 0], u_color: C.ink } },
    text('kmh', 'speed', 3, 'right', 620, 392, 240),
    text('mode', 'big', 1, 'center', 1440, 392, 80),
    text('gearSub', 'f35', 2, 'left', 1484, 392, 60, C.ink2),
    text('rpm', 'mid', 6, 'right', 1520, 462, 80),
    text('driveWord', 'cap', 6, 'center', 1195.6, 248.8, 100, C.calm),
    text('mpg', 'mid', 3, 'center', 1271.6, 231.3, 60),
    text('evMi', 'mid', 6, 'left', 712, 463, 90),
    text('socPct', 'cap', 5, 'left', 712, 490, 60, C.ink2),
    text('limit', 'f35', 3, 'center', 728, 348, 56),
    text('set', 'mid', 3, 'left', 672, 392, 50),
    text('guideDist', 'f35', 7, 'left', 908, 474, 180),
    text('road', 'small', 16, 'left', 908, 502, 180, C.ink2),
    text('eta', 'small', 16, 'right', 1088, 550, 220),
    text('oilC', 'small', 6, 'center', 1816, 598, 70, C.ink2),
    text('range', 'mid', 7, 'left', 238, 624, 100),
    text('clock', 'mid', 5, 'center', 520, 624, 80),
    /* trip and average economy either side of the centre (16 glyphs a layer) */
    text('trip', 'small', 14, 'right', 970, 624, 150, C.ink2),
    text('avg', 'small', 9, 'left', 976, 624, 110, C.ink2),
    text('outside', 'mid', 8, 'right', 1684, 624, 110),
];

const spec = {
    id: 'g20i2c', title: 'G20 inspired 2 · Comfort', family: 'g20i2', mode: 'comfort', version: 2, bottom: 646,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm', 'oilC', 'outsideC',
        'clock', 'limitKmh', 'cruiseKmh', 'instL100', 'turnDir', 'turnM', 'road', 'destKm', 'eta', 'tripKm', 'avgL100'],
    params: {
        speedT0: SPEED_T0, scaleLen: +L.toFixed(2), speedMap: SPEED_MAP, tachMap: G.TACH_MAP,
        barT, driveZero, pwrZero: PWR_ZERO, ecoMax: 0.35, driveHp: 300, regenHp: 40, mpgMax: 80,
        setPos, setStep: 5,
        oil: { cx: 1920 - 332, cy: 432, r: 223, a0: 19, a1: -19, from: 50, to: 150 },
        colors: C,
    },
    fonts: {},
    paths: {
        speed: { path: speedPath, inward: -1, rect: speedRect, maxd: 127 },
        tach: { mirror: 'speed' },
        bars: { path: barPath, inward: 1, rect: barRect, maxd: 12 },
        fuel: { path: fuelPath, inward: 1, rect: fuelRect, maxd: 5 },
        arrowR: { path: arrowR, inward: 1, rect: bbox(arrowR, 5), maxd: 4, ends: true },
        arrowL: { path: arrowL, inward: 1, rect: bbox(arrowL, 5), maxd: 4, ends: true },
    },
    layers,
};
Object.keys(FONTS).forEach((k) => {
    const f = FONTS[k], wt = f.weight || 500;
    spec.fonts[k] = { file: '../fonts/BarlowSemiCondensed-' + wt + '.woff2', weight: wt, size: f.size, cell: f.cell, dy: f.dy, glyphs: f.glyphs };
    if (f.tracking) spec.fonts[k].tracking = f.tracking;
});
writeSpec(__dirname, spec);
console.log('layers', layers.length + 1, 'driveZero', driveZero);
