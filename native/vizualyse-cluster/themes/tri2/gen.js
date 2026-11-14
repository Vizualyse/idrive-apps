// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json and geom.js for the tri2 family ("Three-dial 2")
 * from the mockup's own geometry: five zones (energy columns, power dial,
 * rev counter, tyre pit board, temperature columns), the grooved tracks, the
 * shift ladder. art.html draws the static parts from geom.js, so the art and
 * the layers share one set of numbers.
 *
 *   node themes/tri2/gen.js            Sport (tri2)
 *   node themes/tri2/gen.js comfort    Comfort (tri2c, written to themes/tri2c)
 *
 * The logic lays some rows out itself (two tyres' figures in one text layer),
 * so it needs each font's advances: they come from the built theme
 * (themes/built/<id>.theme.json). After changing a font, build, run this
 * again and build again.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { flatten, measure } = require('../../tools/field.js');

const MODE = process.argv[2] === 'comfort' ? 'comfort' : 'sport';

/* ---- colours: the mockup's oklch ramp, as sRGB ---- */
function oklch(L, C, h, a) {
    const hr = h * Math.PI / 180, A = C * Math.cos(hr), B = C * Math.sin(hr);
    const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    const s = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3);
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
    const g = lin.map((c) => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; });
    return g.map((c) => Math.round(c * 1000) / 1000).concat([a == null ? 1 : a]);
}
const Z = [0.075, 0.135, 0.185, 0.250, 0.320, 0.410, 0.520, 0.640, 0.760, 0.875, 0.975];
const ZC = [0.006, 0.010, 0.012, 0.013, 0.013, 0.012, 0.011, 0.010, 0.008, 0.006, 0.004];
const C = {};
Z.forEach((L, i) => { C['z' + i] = oklch(L, ZC[i], 228); });
Object.assign(C, {
    electric: oklch(0.80, 0.125, 205), signal: oklch(0.64, 0.215, 29), caution: oklch(0.82, 0.150, 75),
    shift: oklch(0.91, 0.205, 126), eco: oklch(0.80, 0.130, 155), none: [0, 0, 0, 0],
});
const css = (c) => 'rgb(' + c.slice(0, 3).map((v) => Math.round(v * 255)).join(' ') + ')';
const R2 = (v) => Math.round(v * 100) / 100;
const lengthOf = (pieces) => { const c = measure(flatten(pieces, 1)); return c[c.length - 1]; };

/* ---- geometry (mockup coordinates; the rev counter's group is moved down 14) ---- */
const G = {
    tach: { cx: 960, cy: 332, a0: -135, a1: 135, max: 8000, red: 7200, grooves: [232, 264, 4], face: 282, track: 248 },
    /* Sport: power -100..600 hp; Comfort: charge / eco / power -60..240 hp, eco to 100 */
    power: { cx: 476, cy: 342, a0: -135, a1: 135, lo: MODE === 'comfort' ? -60 : -100, hi: MODE === 'comfort' ? 240 : 600, eco: 100,
        grooves: [144, 164, 4], face: 184, track: 154 },
    tyres: { cx: 1444, cy: 342, face: 184,
        slats: [{ id: 'FL', x: 1326, y: 262 }, { id: 'FR', x: 1450, y: 262 }, { id: 'RL', x: 1326, y: 354 }, { id: 'RR', x: 1450, y: 354 }] },
    /* the oil column is at 1707, not the mockup's 1706: the battery column's mirror image (one field for both sides) */
    cols: { fuel: 132, batt: 213, oil: 1707, cool: 1788, top: 232, bottom: 468 },
    ladder: { r: 296, from: 36, seg: 6.2, gap: 1.5, n: 5 },
    gear: { x: 923.5, y: 398, mx: 841.7 },
    /* Comfort: D at 966, the gear after it; the next turn's arrow (a right turn; a left one is its mirror in the same rect) */
    cgear: { x: 966, n: 1009.1, y: 494 },
    arrow: [['M', 1352, 436], ['L', 1352, 414], ['A', 1361, 414, 9, 180, 270], ['L', 1382, 405], ['L', 1371, 394], ['L', 1382, 405], ['L', 1371, 416]],
};
const T = G.tach, P = G.power;
/* mockup angles: degrees clockwise from up; field.js's: clockwise from +x */
const fa = (a) => a - 90;
const revA = (r) => T.a0 + (T.a1 - T.a0) * Math.max(0, Math.min(T.max, r)) / T.max;
const pA = (hp) => P.a0 + (P.a1 - P.a0) * (Math.max(P.lo, Math.min(P.hi, hp)) - P.lo) / (P.hi - P.lo);
const P0 = pA(0);
function arcBox(cx, cy, r0, r1, a0, a1, pad) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let a = a0; a <= a1 + 1e-9; a += 0.25) [r0, r1].forEach((r) => {
        const x = cx + r * Math.sin(a * Math.PI / 180), y = cy - r * Math.cos(a * Math.PI / 180);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    });
    const x = Math.floor(x0 - pad), y = Math.floor(y0 - pad);
    return [x, y, Math.ceil(x1 + pad) - x, Math.ceil(y1 + pad) - y];
}

/* rev counter: one arc along the grooves' middle; d > 0 toward the centre.
 * The art has every groove lit; the layer dims them past the revs (the
 * face's colour over them) and draws the needle (r 224..270). */
const tachPath = [['A', T.cx, T.cy, T.track, fa(T.a0), fa(T.a1)]];
const tachRect = arcBox(T.cx, T.cy, 224, 272, T.a0, T.a1, 1);
const TACH_MAXD = 24;

/* power: the whole circle, counter-clockwise from just short of zero, so
 * that the dimmed part is always one stretch: [0, t(total)] driving, [t(regen), 1]
 * recovering. A gap of 1 degree at zero keeps the zero tick out of the field. */
const PW_START = P0 - 0.5, PW_SPAN = 359;
const pwPath = [['A', P.cx, P.cy, P.track, fa(PW_START), fa(PW_START) - PW_SPAN]];
const PW_MAXD = MODE === 'comfort' ? 16 : 12;   /* Comfort's needle runs r 140..170 */
const pwRect = arcBox(P.cx, P.cy, P.track - PW_MAXD, P.track + PW_MAXD, -180, 180, 1);
const arrowRect = [1347, 389, 40, 52];

/* shift ladder: the left half (outer end to the top centre), the right half its mirror */
const L = G.ladder, LAD0 = -(L.from + L.gap / 2);
const ladPath = [['A', T.cx, T.cy, L.r, fa(LAD0), fa(0)]];
const ladLen = lengthOf(ladPath);
const ladCell = (L.seg + L.gap) / -LAD0;              /* one segment and its gap, 0..1 of the path */
const ladRect = arcBox(T.cx, T.cy, L.r - 5, L.r + 5, LAD0, 0, 1);
ladRect[2] = 962 - ladRect[0];

/* energy columns: fuel top to bottom, a turn below (outside the rect), the
 * battery bottom to top; the temperatures are the mirror image (coolant, oil) */
const K = G.cols, DROP = 52;
const colPath = [['M', K.fuel, K.top], ['L', K.fuel, K.bottom], ['L', K.fuel, K.bottom + DROP],
    ['L', K.batt, K.bottom + DROP], ['L', K.batt, K.bottom], ['L', K.batt, K.top]];
const colLen = lengthOf(colPath), colH = K.bottom - K.top;
const colT = { t1: colH / colLen, t2: (colLen - colH) / colLen };
const colRect = [K.fuel - 9, K.top, K.batt - K.fuel + 19, colH];

/* ---- fonts (static cuts of Archivo, fonts/make_fonts.py). Archivo: ascent
 * 0.878, descent 0.210, so a glyph's baseline sits at h/2 + 0.334 size + dy
 * in its cell; each font's cell is set so its baseline is at row B. ---- */
const SMALL_ALL = '0123456789 -−°%:·,./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FONTS = MODE === 'comfort' ? {
    speed: { file: 'gear', weight: 600, size: 178, cell: [114, 134], B: 130, glyphs: '0123456789- ' },
    v30: { file: 'val', weight: 560, size: 30, cell: [30, 28], B: 25, glyphs: '0123456789.-– miydEV' },
    sign: { file: 'sign', weight: 700, size: 27, cell: [18, 24], B: 21, glyphs: '0123456789- ' },
    mpg: { file: 'num', weight: 560, size: 54, cell: [38, 42], B: 40, glyphs: '0123456789.- ' },
    val: { file: 'val', weight: 560, size: 22, cell: [24, 20], B: 18, glyphs: '0123456789 .-−%°Cmi' },
    small: { file: 'small', weight: 460, size: 16, cell: [17, 20], B: 15, glyphs: SMALL_ALL },
    zone: { file: 'tc', weight: 600, size: 14, cell: [14, 13], B: 12, glyphs: 'ECOHARGPWN ', tracking: 1.4 },
} : {
    gear: { file: 'gear', weight: 600, size: 236, cell: [170, 176], B: 171, glyphs: '12345678NR- ' },
    num: { file: 'num', weight: 560, size: 66, cell: [46, 52], B: 49, glyphs: '0123456789-− ' },
    speed: { file: 'num', weight: 560, size: 56, cell: [40, 44], B: 42, glyphs: '0123456789- ' },
    tp: { file: 'val', weight: 560, size: 36, cell: [27, 30], B: 28, glyphs: '0123456789- ' },
    val: { file: 'val', weight: 560, size: 24, cell: [28, 22], B: 20, glyphs: '0123456789 -−%°C' },
    small: { file: 'small', weight: 460, size: 16, cell: [17, 20], B: 15, glyphs: '0123456789 -−°Cmi:·,ElectrRovngNaWHk/hL' },
    tc: { file: 'tc', weight: 600, size: 13, cell: [12, 12], B: 11, glyphs: 'COLDW ', tracking: 1 },
};
const FONT_DIR = MODE === 'comfort' ? '../tri2/fonts/' : 'fonts/';
const built = (() => {
    const id = MODE === 'comfort' ? 'tri2c' : 'tri2';
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'built', id + '.theme.json'), 'utf8')); } catch (e) { return null; }
})();
function advances(font) {
    const f = FONTS[font];
    const l = built && built.layers.find((x) => x.shader === 'text' && x.glyphs === f.glyphs && x.cellW === f.cell[0] && x.adv);
    return l ? l.adv : f.glyphs.split('').map(() => Math.round(f.cell[0] * 0.6));
}

/* a text layer by its baseline and anchor (right end, left start or centre) */
function text(name, font, cells, align, ax, by, color, w) {
    const f = FONTS[font];
    w = w || f.cell[0] * cells;
    const x = align === 'right' ? ax - w : align === 'center' ? ax - w / 2 : ax;
    const l = { name, shader: 'text', font, x: Math.round(x), y: Math.round(by - f.B), cells, align };
    if (w !== f.cell[0] * cells) l.w = w;
    l.uniforms = { u_color: color || C.z10 };
    return l;
}

/* dim colours: the faces' colour under the grooves (measured in the built art) */
const TACH_DIM = [0.008, 0.024, 0.035], PW_DIM = [0.008, 0.016, 0.02], FACE_MID = [0.02, 0.043, 0.055];
const DIM_A = 0.9;
/* white grooves to electric: subtracted (the art's white less this, clamped at black, so the gaps stay dark) */
const LIT = MODE === 'comfort' ? C.z8 : C.z10;   /* the art's lit grooves */
const tint = C.electric.slice(0, 3).map((c, i) => R2((c - LIT[i]) / 1.5)).concat([10]);

function sportLayers() {
const layers = [
    { name: 'tach', shader: 'gauge', field: 'tach', uniforms: {
        u_val: [0, 0, 2, 0], u_band: [-17, 17, -22, TACH_MAXD], u_shape: [127, 2, 2, 0],
        u_fill: TACH_DIM.concat([DIM_A]), u_red: TACH_DIM.concat([DIM_A]), u_glow: C.none, u_needle: C.z10,
        u_seg: [0, 0, 1, 1], u_look: [0, 0, 1, 0] } },
    { name: 'pwTint', shader: 'gauge', field: 'power', uniforms: {
        u_val: [0, 0, 2, 1], u_band: [-12, 12, 0, 0], u_shape: [127, 0, 0, 1],
        u_fill: C.none, u_red: C.none, u_glow: [0, 0, 0, 0], u_needle: C.none,
        u_seg: [0, 0, 0, 1], u_look: [1, 0, 1, 0] } },
    { name: 'pwDim', shader: 'gauge', field: 'power', art: false, uniforms: {
        u_val: [0, 0, 2, 0], u_band: [-12, 12, 0, 0], u_shape: [127, 0, 0, 0],
        u_fill: PW_DIM.concat([DIM_A]), u_red: PW_DIM.concat([DIM_A]), u_glow: PW_DIM.concat([0]), u_needle: C.none,
        u_seg: [0, 0, 0, 1], u_look: [0, 0, 1, 0] } },
    ...['ladderL', 'ladderR'].map((name) => ({ name, shader: 'gauge', field: name === 'ladderL' ? 'ladder' : 'ladderR', uniforms: {
        u_val: [0, 0, 2, 0], u_band: [-4.5, 4.5, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: C.shift, u_red: C.shift, u_glow: C.none, u_needle: C.none,
        u_seg: [L.n, R2(L.gap * Math.PI / 180 * L.r), 0, R2(ladCell * L.n * 1000) / 1000], u_look: [0, 0, 1, 0] } })),
    /* the columns: one band from the fuel's level down, round the turn, up the battery to its level */
    { name: 'stores', shader: 'gauge', field: 'stores', art: false, uniforms: {
        u_val: [colT.t2, 0, R2((colT.t1 + colT.t2) / 2 * 1e4) / 1e4, 0], u_band: [-9, 9, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: C.z9, u_red: C.electric, u_glow: C.none, u_needle: C.none, u_seg: [0, 0, colT.t1, 1], u_look: [0, 0, 1, 0] } },
    { name: 'temps', shader: 'gauge', field: 'temps', art: false, uniforms: {
        u_val: [colT.t2, 0, 2, 0], u_band: [-9, 9, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: C.z9, u_red: C.z9, u_glow: C.none, u_needle: C.none, u_seg: [0, 0, colT.t1, 1], u_look: [0, 0, 1, 0] } },
    /* the art's mode letter hidden when the gearbox is not in M */
    { name: 'gmMask', shader: 'rect', x: 836, y: 328, w: 88, h: 76, uniforms: { u_shape: [0, 0, 0, 0], u_color: FACE_MID.concat([1]) } },
];
const S = G.tyres.slats;
S.forEach((s, i) => layers.push(
    { name: 'tyreBar' + i, shader: 'leds', x: s.x + 10, y: s.y + 70, w: 92, h: 3, uniforms: {
        u_led: [46, 0, 0, 0], u_geom: [0, 0, 2, 3], u_split: [99, 99, 0, 0], u_lean: [0, 0, 0, 0],
        u_c0: C.z8, u_c1: C.z8, u_c2: C.z8, u_off: C.none } },
    { name: 'tyreRing' + i, shader: 'rect', x: s.x, y: s.y, w: 112, h: 80, uniforms: {
        u_shape: [0, 0, 3, 1.5], u_color: C.none, u_ring: C.caution } }));
const SLAT_W = 112 * 2 + 12;   /* a row: two slats, from the left one's x */
layers.push(
    text('gear', 'gear', 2, 'left', G.gear.x, G.gear.y),
    text('speed', 'speed', 3, 'center', 960, 466),
    text('pTotal', 'num', 4, 'center', 476, 340),
    text('pEng', 'val', 4, 'right', 552, 413),
    text('pEle', 'val', 4, 'right', 552, 447),
    text('pEleLbl', 'small', 10, 'left', 414, 446, C.z8),
    /* two columns a layer, and a tyre's figures: the logic places each part itself (params.lay) */
    text('storeVal', 'val', 12, 'left', K.fuel - 70, 506, C.z10, K.batt - K.fuel + 140),
    text('storeSub', 'small', 13, 'left', K.fuel - 70, 530, C.z7, K.batt - K.fuel + 140),
    text('tempVal', 'val', 13, 'left', K.oil - 70, 506, C.z10, K.cool - K.oil + 140),
    text('tempSub', 'small', 15, 'left', K.oil - 70, 530, C.z7, K.cool - K.oil + 140),
    ...S.map((s, i) => text('psi' + i, 'tp', 3, 'left', s.x + 10, s.y + 60, C.z10, 70)),
    ...S.map((s, i) => text('temp' + i, 'small', 4, 'right', s.x + 102, s.y + 60, C.z9, 40)),
    text('flagF', 'tc', 9, 'left', S[0].x, S[0].y + 21, C.z6, SLAT_W),
    text('flagR', 'tc', 9, 'left', S[2].x, S[2].y + 21, C.z6, SLAT_W),
    /* "14:32 · 18 °C" ends where the mockup's second separator's space starts; " · 14,551 mi" from there */
    text('metaA', 'small', 13, 'right', 965.3, 602, C.z7),
    text('metaB', 'small', 12, 'left', 965.3, 602, C.z7),
);
return layers;
}

/* Comfort: the rev ring quietened (z8 grooves, a 3 px z9 needle), no ladder;
 * charge / eco / power with a needle at the total; the map area and the next
 * turn on the right */
function comfortLayers() {
const layers = [
    { name: 'tach', shader: 'gauge', field: 'tach', uniforms: {
        u_val: [0, 0, 2, 0], u_band: [-17, 17, -22, 22], u_shape: [127, 1.5, 1.5, 0],
        u_fill: TACH_DIM.concat([DIM_A]), u_red: TACH_DIM.concat([DIM_A]), u_glow: C.none, u_needle: C.z9,
        u_seg: [0, 0, 1, 1], u_look: [0, 0, 1, 0] } },
    { name: 'pwTint', shader: 'gauge', field: 'power', uniforms: {
        u_val: [0, 0, 2, 1], u_band: [-12, 12, 0, 0], u_shape: [127, 0, 0, 1],
        u_fill: C.none, u_red: C.none, u_glow: [0, 0, 0, 0], u_needle: C.none,
        u_seg: [0, 0, 0, 1], u_look: [1, 0, 1, 0] } },
    { name: 'pwDim', shader: 'gauge', field: 'power', art: false, uniforms: {
        u_val: [0, 0, 2, 0], u_band: [-12, 12, -16, 14], u_shape: [127, 1.5, 1.5, 0],
        u_fill: PW_DIM.concat([DIM_A]), u_red: PW_DIM.concat([DIM_A]), u_glow: PW_DIM.concat([0]), u_needle: C.z10,
        u_seg: [0, 0, 0, 1], u_look: [0, 0, 1, 0] } },
    { name: 'stores', shader: 'gauge', field: 'stores', art: false, uniforms: {
        u_val: [colT.t2, 0, R2((colT.t1 + colT.t2) / 2 * 1e4) / 1e4, 0], u_band: [-9, 9, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: C.z9, u_red: C.electric, u_glow: C.none, u_needle: C.none, u_seg: [0, 0, colT.t1, 1], u_look: [0, 0, 1, 0] } },
    { name: 'temps', shader: 'gauge', field: 'temps', art: false, uniforms: {
        u_val: [colT.t2, 0, 2, 0], u_band: [-9, 9, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: C.z7, u_red: C.z7, u_glow: C.none, u_needle: C.none, u_seg: [0, 0, colT.t1, 1], u_look: [0, 0, 1, 0] } },
    { name: 'arrow', shader: 'gauge', field: 'arrow', art: false, uniforms: {
        u_val: [1, 0, 2, 0], u_band: [-2.25, 2.25, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: C.z10, u_red: C.z10, u_glow: C.none, u_needle: C.none, u_seg: [0, 0, 0, 1], u_look: [0, 0, 1, 0] } },
    /* the art's D hidden when the gearbox is not in D */
    { name: 'gmMask', shader: 'rect', x: 962, y: 454, w: 46, h: 44, uniforms: { u_shape: [0, 0, 0, 0], u_color: FACE_MID.concat([1]) } },
    text('speed', 'speed', 3, 'center', 960, 394),
    text('setV', 'v30', 3, 'left', 959.7, 226, C.z6),
    text('limit', 'sign', 3, 'center', 916, 485.5, oklch(0.16, 0.01, 228)),
    text('gearN', 'v30', 2, 'left', G.cgear.n, G.cgear.y, C.z8),
    /* the lit zone label, moved over the art's unlit one */
    text('zoneOn', 'zone', 7, 'center', 476, 238, C.z10),
    text('mpg', 'mpg', 5, 'center', 476, 340, C.z9),
    text('evMi', 'val', 8, 'right', 562, 413),
    text('trip', 'val', 8, 'right', 562, 447),
    text('storeVal', 'val', 10, 'left', K.fuel - 70, 506, C.z10, K.batt - K.fuel + 140),
    text('storeUnit', 'small', 4, 'left', K.fuel - 70, 506, C.z7, K.batt - K.fuel + 140),
    text('storeSub', 'small', 10, 'left', K.fuel - 70, 530, C.z7, K.batt - K.fuel + 140),
    text('tempVal', 'val', 13, 'left', K.oil - 70, 506, C.z8, K.cool - K.oil + 140),
    text('tempSub', 'small', 15, 'left', K.oil - 70, 530, C.z7, K.cool - K.oil + 140),
    text('navDist', 'v30', 8, 'left', 1402, 417),
    text('road', 'small', 16, 'left', 1402, 442, C.z8, 190),
    /* one line in two layers (16 glyphs a layer), centred together by the logic */
    text('etaA', 'small', 14, 'left', 1300, 476, C.z8, 290),
    text('etaB', 'small', 12, 'left', 1300, 476, C.z8, 290),
    text('tyresA', 'small', 14, 'left', 1300, 502, C.z7, 290),
    text('tyresB', 'small', 15, 'left', 1300, 502, C.z7, 290),
    text('metaA', 'small', 13, 'right', 965.3, 602, C.z7),
    text('metaB', 'small', 12, 'left', 965.3, 602, C.z7),
];
return layers;
}
const layers = MODE === 'comfort' ? comfortLayers() : sportLayers();

const lay = {};
layers.filter((l) => l.shader === 'text').forEach((l) => { lay[l.name] = { x: l.x, w: l.w || FONTS[l.font].cell[0] * l.cells, font: l.font }; });
const fontsAdv = {};
Object.keys(FONTS).forEach((k) => { fontsAdv[k] = { glyphs: FONTS[k].glyphs, adv: advances(k), cellW: FONTS[k].cell[0] }; });

const spec = {
    id: MODE === 'comfort' ? 'tri2c' : 'tri2',
    title: MODE === 'comfort' ? 'Three-dial 2 · Comfort' : 'Three-dial 2',
    family: 'tri2', mode: MODE, version: 2, bottom: 646,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'throttle', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm',
        'oilC', 'coolantC', 'tyres', 'outsideC', 'odoKm', 'clock'],
    params: {
        tach: { max: T.max, red: T.red },
        /* the shift ladder: segment i lit from from + i * step rpm, all flashing from due (the sim shifts at 6600) */
        ladder: { from: 5300, step: 260, due: 6400, n: L.n, cell: +ladCell.toFixed(5) },
        power: { lo: P.lo, hi: P.hi, a0: P.a0, a1: P.a1, start: PW_START, span: PW_SPAN },
        cols: colT, colX: { fuel: K.fuel, batt: K.batt, oil: K.oil, cool: K.cool }, tempFrom: 40, tempTo: 160, oilHot: 120, coolHot: 110,
        tyres: { target: [2.4, 2.4, 2.6, 2.6], low: 0.2, cold: 60, hot: 100, x: G.tyres.slats.map((s) => s.x) },
        tint, colors: C, fonts: fontsAdv, lay, gearY: FONTS.gear ? Math.round(G.gear.y - FONTS.gear.B) : 0, zoneB: FONTS.zone ? FONTS.zone.B : 0,
        modeLetter: MODE === 'comfort' ? 'D' : 'M',
    },
    fonts: {},
    paths: {
        tach: { path: tachPath, inward: -1, rect: tachRect, maxd: TACH_MAXD },
        power: { path: pwPath, inward: 1, rect: pwRect, maxd: PW_MAXD },
        stores: { path: colPath, inward: 1, rect: colRect, maxd: 10 },
        temps: { mirror: 'stores' },
    },
    layers,
};
if (MODE === 'comfort') {
    spec.paths.arrow = { path: G.arrow, inward: 1, rect: arrowRect, maxd: 3, ends: true };
    spec.signals = spec.signals.filter((k) => k !== 'throttle' && k !== 'tyres').concat(['tyres', 'tripKm', 'avgL100',
        'limitKmh', 'cruiseKmh', 'turnDir', 'turnM', 'road', 'destKm', 'eta']);
    delete spec.params.ladder;
    spec.params.power.eco = P.eco;
    spec.params.zones = { charge: [326, 500], eco: [476, 238], power: [626, 500] };
} else {
    spec.paths.ladder = { path: ladPath, inward: -1, rect: ladRect, maxd: 5 };
    spec.paths.ladderR = { mirror: 'ladder' };
}
spec.params.mode = MODE;
if (MODE === 'comfort') fs.mkdirSync(path.join(__dirname, '..', 'tri2c'), { recursive: true });
if (MODE === 'comfort') ['logic.js', 'art.html'].forEach((f) => fs.copyFileSync(path.join(__dirname, f), path.join(__dirname, '..', 'tri2c', f)));
Object.keys(FONTS).forEach((k) => {
    const f = FONTS[k];
    spec.fonts[k] = { file: FONT_DIR + 'Archivo-' + f.file + '.woff2', weight: f.weight, size: f.size, cell: f.cell,
        dy: R2(f.B - f.cell[1] / 2 - 0.334 * f.size), glyphs: f.glyphs, tracking: f.tracking || 0 };
});

/* geometry and colours for art.html */
const geom = { G, C: Object.fromEntries(Object.keys(C).map((k) => [k, css(C[k])])), P0, mode: MODE,
    targetPsi: [Math.round(2.4 * 14.504), Math.round(2.6 * 14.504)] };
const outDir = MODE === 'comfort' ? path.join(__dirname, '..', 'tri2c') : __dirname;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'geom.js'), '// written by themes/tri2/gen.js\nwindow.GEOM = ' + JSON.stringify(geom) + ';\n');
const json = JSON.stringify(spec, null, 1)
    .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']');
fs.writeFileSync(path.join(outDir, 'theme.src.json'), json + '\n');
console.log(spec.id, 'layers', layers.length + 1, 'tach', tachRect, 'power', pwRect, 'ladder', ladRect, 'cols', colRect,
    'adv from build:', !!built, 'tint', tint);
