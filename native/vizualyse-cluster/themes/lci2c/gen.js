// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json and geom.js for "LCI inspired 2 · Comfort" (lci2c),
 * the Comfort half of the lci2 family, from the Comfort mockup (the Sport
 * mockup's source edited): the same lens and bands (lci2/gen.js), with the
 * speed limit and cruise above the speed box, D + gear, next turn, TO GO and
 * ARRIVAL over a centre-zero CHARGE / ECO / POWER meter, an empty map panel,
 * BATTERY, E-RANGE, ECONOMY and AVG SPEED, coolant and tyres.
 *   node themes/lci2c/gen.js
 */
'use strict';
const L = require('../lci2/gen.js');
const { C, hex, font, write, bandPath, bandRect, REACH, BAND_LEN, speedMap, tachMap } = L;

const SC = '../lci2/SairaSemiCondensed.woff2', SN = '../lci2/Saira-latin.woff2';
const FONTS = {
    display: font(SC, 132, 600, 76, '0123456789 -', -1.32),
    gear: font(SC, 60, 600, 40, '0123456789-N', -0.6),
    power: font(SC, 40, 500, 24, '0123456789 .:-'),
    mid: font(SC, 30, 500, 19, '0123456789 .-–'),
    body: font(SC, 18, 500, 16, '0123456789 -%°CFR·'),
    num25: font(SC, 25, 500, 16, '0123456789:- '),
    sm: font(SN, 17, 500, 19, 'CHARGEOPWV ', 1.36),
    unit: font(SN, 15, 400, 15, '0123456789 -°Cmiyd−'),
    label: font(SN, 13, 500, 16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.\'', 1.82),
};
const baseIn = (f) => FONTS[f].cell[1] / 2 + 0.348 * FONTS[f].size + FONTS[f].dy;
function text(name, f, cells, align, ax, by, color) {
    const w = FONTS[f].cell[0] * cells;
    const x = align === 'right' ? ax - w : align === 'center' ? ax - w / 2 : ax;
    const l = { name, shader: 'text', font: f, x: Math.round(x), y: Math.round(by - baseIn(f)), cells, align };
    if (color) l.uniforms = { u_color: color };
    return l;
}

/* advances measured in Chrome at the mockup's sizes (Saira) */
const R2 = (v) => Math.round(v * 100) / 100;
const MID = { d: 16.63, '.': 6.73 }, P40 = { d: 22.17, '.': 8.97 }, UNIT = { m: 13.23, i: 3.81, p: 8.86, h: 9, g: 8.86 };
const w = (A, s) => s.split('').reduce((n, c) => n + (/\d/.test(c) ? A.d : A[c]), 0);
const U = {
    setR: 551 + w(MID, '70'), tripR: 1280 + w(MID, '23.4'), togoR: 948 + w(P40, '23.0'),
    rangeR: 640 - w(UNIT, 'mi') - 5, socR: 712 + w(MID, '71'), erR: 852 + w(MID, '21'),
    mpgR: 976 + w(MID, '48.8'), avgR: 1100 + w(MID, '41'),
};
U.setU = U.setR + 5; U.tripU = U.tripR + 5; U.togoU = U.togoR + 6; U.rangeU = U.rangeR + 5;
U.socU = U.socR + 4; U.erU = U.erR + 4; U.mpgU = U.mpgR + 4; U.avgU = U.avgR + 4;
Object.keys(U).forEach((k) => { U[k] = R2(U[k]); });

/* gear: "D" (128 px) + 8 + the gear (60 px, muted), centred at 1403 as one text */
const D_W = 74.25, G_W = 32.7;
const dX = R2(1403 - (D_W + 8 + G_W) / 2), gearX = R2(dX + D_W + 8);
/* zone labels (sm: 17 px, tracked .08 em): whole-pixel widths, as the build lays them out */
const SM = { C: 11.11, H: 13.75, A: 13, R: 12.91, G: 12.8, E: 11.67, O: 13.47, P: 12.42, W: 18.19 };
const smW = (s) => s.split('').reduce((n, c) => n + Math.round(SM[c]), 0);
const ZONES = { CHARGE: 712, ECO: Math.round(947 - smW('ECO') / 2), POWER: 1208 - smW('POWER') };
const P40W = { d: 22, '.': 9 };   /* the power font's whole-pixel advances, for the turn unit */

const MAX_HP = 300, NEG_HP = 100, Z = 836, POS = 372, NEG = 124;
const C2 = Object.assign({}, C, { calm: hex('#c9d8f2'), signInk: hex('#0a0e18') });

const none = C.none;
const layers = [
    { name: 'speed', shader: 'gauge', field: 'band', uniforms: {
        u_v: [0, 0, 2, 1], u_band: [-5.5, 6.5, -9, 9], u_shape: [1, 1.5, 1.5, 1], u_fill: C.speed, u_red: none,
        u_glow: [0, 0, 0, 30], u_needle: C.ink, u_seg: [0, 0, +(0.6 / BAND_LEN).toFixed(5), 1], u_pool: [0, 0, 0, 0], u_look: [REACH, 0.65, 1, 0] } },
    { name: 'tach', shader: 'gauge', field: 'tachBand', uniforms: {
        u_v: [0, 0, 2, 1], u_band: [-5.5, 6.5, -9, 9], u_shape: [1, 1.5, 1.5, 1], u_fill: C.ink2, u_red: none,
        u_glow: [0, 0, 0, 30], u_needle: C.ink, u_seg: [0, 0, +(0.6 / BAND_LEN).toFixed(5), 1], u_pool: [0, 0, 0, 0], u_look: [REACH, 0.65, 1, 0] } },
    /* the cruise set speed: a 14 px green triangle on the lens side of the band (a needle 0 wide at d 10, 14 at d 23) */
    { name: 'setMark', shader: 'gauge', field: 'band', art: false, uniforms: {
        u_v: [0, 0, 2, 1], u_band: [0, 0, 10, 23], u_shape: [1, 0.5, 7, 1], u_fill: none, u_red: none,
        u_glow: none, u_needle: C.ok, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0], u_look: [0, 0, 2, 0] } },
    /* the next turn's arrow; mirrored about its own middle (u_pool.w) for a left turn */
    { name: 'arrow', shader: 'gauge', field: 'arrow', art: false, uniforms: {
        u_v: [1, 0, 2, 1], u_band: [-2, 2, 0, 0], u_shape: [1, 0, 0, 1], u_fill: C.ink, u_red: none,
        u_glow: none, u_needle: none, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0], u_look: [0, 0, 2, 0] } },
    /* the meter: drive to the right of zero (engine pale, electric cyan), regen a hatch to the left */
    { name: 'meterPos', shader: 'leds', x: Z, y: 176, w: POS, h: 12, uniforms: {
        u_led: [POS, 0, 0, 0], u_geom: [0, 0, 1, 12], u_split: [0, 9999, 0, 0], u_c0: C2.calm, u_c1: C.elec, u_c2: C.elec, u_off: none } },
    { name: 'meterNeg', shader: 'leds', x: Z - NEG, y: 176, w: NEG, h: 12, uniforms: {
        u_led: [19, 0, 0, 0], u_geom: [0, 0, 3.4, 12], u_split: [99, 99, 0, 0], u_lean: [12, 0, 0, 0], u_c0: C.elec, u_c1: C.elec, u_c2: C.elec, u_off: none } },
    { name: 'modeMask', shader: 'rect', x: Math.floor(dX) - 3, y: 270, w: 82, h: 98, uniforms: { u_color: C.box } },
    { name: 'fuelSegs', shader: 'leds', x: 471, y: 480, w: 170, h: 8, uniforms: {
        u_led: [10, 0, 0, 0], u_geom: [0, 0, 14, 8], u_split: [99, 99, 0, 0], u_c0: C.ink2, u_c1: C.ink2, u_c2: C.ink2, u_off: C.track } },
    { name: 'coolBar', shader: 'leds', x: 1280, y: 480, w: 168, h: 8, uniforms: {
        u_led: [168, 0, 0, 0], u_geom: [0, 0, 1, 8], u_split: [999, 999, 0, 0], u_c0: C.ink2, u_c1: C.ink2, u_c2: C.ink2, u_off: none } },
    { name: 'socBar', shader: 'leds', x: 782, y: 538, w: 36, h: 6, uniforms: {
        u_led: [36, 0, 0, 0], u_geom: [0, 0, 1, 6], u_split: [999, 999, 0, 0], u_c0: C.elec, u_c1: C.elec, u_c2: C.elec, u_off: none } },
    text('spd', 'display', 3, 'center', 517, 344),
    text('limit', 'mid', 3, 'center', 501, 156, C2.signInk),
    text('setV', 'mid', 3, 'right', U.setR, 168),
    text('trip', 'mid', 5, 'right', U.tripR, 168),
    text('gear', 'gear', 1, 'left', gearX, 364, C.ink2),
    text('evTag', 'sm', 2, 'center', 1403, 252, C.elec),
    text('road', 'label', 16, 'left', 712, 122, C.ink2),
    text('turnV', 'power', 4, 'left', 764, 160),
    text('turnU', 'unit', 2, 'left', 860, 160, C.ink2),
    text('togo', 'power', 5, 'right', U.togoR, 160),
    text('eta', 'power', 5, 'right', 1208, 160),
    text('zone', 'sm', 6, 'left', 712, 216, C.ink),
    text('fuelPct', 'body', 5, 'right', 640, 467),
    text('range', 'num25', 4, 'right', U.rangeR, 542),
    text('cool', 'body', 6, 'right', 1448, 467),
    text('tyres', 'body', 11, 'right', 1448, 542),
    text('soc', 'mid', 3, 'right', U.socR, 548),
    text('erange', 'mid', 3, 'right', U.erR, 548, C.elec),
    text('mpg', 'mid', 5, 'right', U.mpgR, 548),
    text('avg', 'mid', 3, 'right', U.avgR, 548),
    text('clock', 'num25', 5, 'left', 150, 626),
    text('otemp', 'unit', 6, 'left', 226, 626, C.ink2),
    text('odo', 'unit', 10, 'right', 1770, 600, C.ink2),
];

const spec = {
    id: 'lci2c', title: 'LCI inspired 2 · Comfort', family: 'lci2', mode: 'comfort', version: 2, bottom: 646,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm', 'coolantC', 'tyres',
        'limitKmh', 'cruiseKmh', 'turnDir', 'turnM', 'road', 'destKm', 'eta', 'tripKm', 'avgL100', 'avgKmh', 'clock', 'outsideC', 'odoKm'],
    params: {
        speedMap, tachMap, maxHp: MAX_HP, negHp: NEG_HP, pos: POS, neg: NEG, zero: Z, ecoEnd: 1059 - Z,
        zones: ZONES, turn: { x: 764, adv: P40W, gap: 6 },
        colors: C2,
    },
    fonts: FONTS,
    paths: {
        band: { path: bandPath, inward: -1, rect: bandRect, maxd: REACH, ends: true, step: 1 },
        tachBand: { mirror: 'band' },
        arrow: { path: [['M', 722, 167], ['L', 722, 142], ['L', 746, 142], ['L', 736, 132], ['L', 746, 142], ['L', 736, 152]],
            inward: 1, rect: [717, 128, 34, 42], maxd: 3, ends: true, step: 1 },
    },
    layers,
};
write(__dirname, spec, { U, dX, gearX });
