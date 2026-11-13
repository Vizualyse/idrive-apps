// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for perf1c ("Performance 1 · Comfort"), the perf1
 * family's Comfort theme, from the Comfort mockup's own geometry
 * (comfort/perf-fable index.src.html, DESIGN.md "Comfort variant"): the same
 * two dials in Calm (the rev counter dimmed), a white needle, the speed-limit
 * sign and cruise, guidance in the shift lights' place, the range split over
 * the drive meter, economy, the map area (an empty panel), HV battery and
 * arrival, fuel, trip, coolant and tyres. art.html draws the static parts.
 *   node themes/perf1c/gen.js        (fonts: themes/perf1/fonts/fonts.py)
 */
'use strict';
const G = require('../perf1/gen_lib.js');
const { C, hex, font, fontSpec, text, textRow, dialPath, leds, barLeds, rect } = G;

const SX = 330, TX = 1590, CY = 318;
const CALM = hex('#c4d3e6'), LIMIT = hex('#ff3a22'), ELEC = C.elec;

/* ---- fonts: eight atlases (12 assets less the art, two dial fields and the arrow) ---- */
const F = {
    big: font('600-108', 116, '0123456789- '),
    d96: font('600-108', 96, 'DMSPRN- '),
    r68: font('600-108', 68, '0123456789- '),
    p40: font('600-108', 40, '0123456789- '),
    r36: font('600-108', 36, '0123456789.- '),
    r31: font('600-108', 31, '0123456789:.,- miydOKLW'),
    s24: font('600-108', 24, '0123456789:−-+ °CEV'),
    u20: font('500-100', 20, " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/°%.-'"),
};

/* ---- dials: the speedometer's field reaches out to the cruise pointer (r 281..303) ---- */
const R_PATH = 258;
const dS = dialPath(SX, CY, R_PATH, 2, 47, 190), dT = dialPath(TX, CY, R_PATH, 2, 32, 190);
const dialU = (d, dim) => ({
    /* the trail: two steps over the last 30 degrees */
    u_v: [d.t0, 0, 2, +(30 / 244).toFixed(4)],
    /* value arc 6 wide on r 272 (d -17..-11); needle r 234..282 (d 24..-24) */
    u_band: [-17, -11, -24, 24],
    u_shape: [100, 2, 2, 0.44],
    u_fill: [CALM[0], CALM[1], CALM[2], dim], u_red: [CALM[0], CALM[1], CALM[2], dim],
    u_glow: G.scaleRGB(CALM, 0.2 * dim).slice(0, 3).concat([1]),
    u_needle: C.ink,
    u_seg: [0, 0, +d.t0.toFixed(5), 1],
    /* the needle's 3 px Calm glow */
    u_pool: [10, 1.2, 0, 0],
    u_look: [0, 8, 1, 0],
});

/* ---- the turn arrow: the mockup's right arrow (translate 780 22, scale 1.5, stroke 5.1),
 * in a rectangle centred on its axis (x 801), so the left one is the field mirrored ---- */
const A = (x, y) => [+(780 + 1.5 * x).toFixed(2), +(22 + 1.5 * y).toFixed(2)];
const arrowPath = [['M'].concat(A(6, 26)), ['L'].concat(A(6, 13)), ['Q'].concat(A(6, 7), A(12, 7)), ['L'].concat(A(23, 7)),
    ['L'].concat(A(17, 1)), ['L'].concat(A(23, 7)), ['L'].concat(A(17, 13))];

/* the tyre line's sub font advances: logic and art both lay "35 35 / 38 38 psi" out from 1610 */
const layers = [
    { name: 'speedDial', shader: 'gauge', field: 'speedDial', uniforms: dialU(dS, 1) },
    { name: 'tachDial', shader: 'gauge', field: 'tachDial', uniforms: dialU(dT, 0.55) },
    /* the cruise set speed: a pointer outside the scale (solid; the mockup's is hollow) */
    { name: 'cruisePtr', shader: 'gauge', field: 'speedDial', art: false, uniforms: {
        u_v: [0, 0, 2, 0], u_band: [0, 0, -45, -23], u_shape: [1, 9, 0.8, 0], u_fill: C.none, u_red: C.none,
        u_glow: [0, 0, 0, 0], u_needle: C.ink, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0], u_look: [0, 0, 1, 0] } },

    /* top row: time, outside, guidance (arrow, distance, road) */
    text('clock', F.s24, 's24', 5, 'end', 640, 53, C.ink),
    text('outside', F.s24, 's24', 6, 'end', 722, 53, C.ink2),
    { name: 'arrow', shader: 'gauge', field: 'arrow', art: false, uniforms: {
        u_v: [1, 0, 2, 0], u_band: [-2.55, 2.55, 0, 0], u_shape: [1, 0, 0, 0], u_fill: C.ink, u_red: C.ink,
        u_glow: [0, 0, 0, 0], u_needle: C.none, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0], u_look: [0, 0, 1, 0] } },
    text('gDist', F.r31, 'r31', 7, 'start', 832, 56, C.ink),
    textRow('road', F.u20, 'u20', 956, 1190, 56, C.ink2),

    /* the speedometer's centre: limit, speed, cruise */
    text('limit', F.s24, 's24', 3, 'middle', SX, CY - 90, C.ground),
    text('speed', F.big, 'big', 3, 'middle', SX, CY + 34, C.ink),
    textRow('cruiseLab', F.u20, 'u20', 220, 323, CY + 124, C.ink3),
    text('cruiseSet', F.s24, 's24', 3, 'start', SX + 2, CY + 125, C.ink),

    /* the rev counter's centre: EV light, D and the gear, rpm */
    textRow('ev', F.s24, 's24', TX - 40, TX + 40, CY - 92, ELEC),
    text('gearMode', F.d96, 'd96', 1, 'middle', TX - 18, CY + 26, C.ink),
    text('gear', F.r36, 'r36', 1, 'start', TX + 26, CY + 26, C.ink2),
    text('rpm', F.r31, 'r31', 5, 'end', TX + 22, CY + 88, C.ink),
    text('rpmUnit', F.u20, 'u20', 3, 'start', TX + 30, CY + 88, C.ink2, { text: 'rpm' }),

    /* range split over the drive meter (-40..120 over x 648..1272; engine Calm, electric blue, regen left of zero) */
    textRow('ranges', F.p40, 'p40', 648, 1240, 174, C.ink),
    textRow('rangeUnit', F.u20, 'u20', 648, 820, 174, C.ink2),
    text('range', F.r68, 'r68', 4, 'middle', 950, 184, C.ink),
    barLeds('engBar', 805, 214, 467, 16, CALM),
    barLeds('elBar', 805, 214, 200, 16, ELEC),

    /* economy and battery row (numbers at y 362) */
    textRow('n362', F.r36, 'r36', 648, 1200, 362, C.ink),
    textRow('u362', F.u20, 'u20', 648, 1230, 362, C.ink2),
    barLeds('nowBar', 648, 376, 160, 8, CALM),
    rect('avgMark', 647, 372, 3, 16, 0, C.ink),
    text('now', F.s24, 's24', 3, 'end', 808, 440, C.ink),
    leds('hv', 1111, 376, 162, 8, { u_led: [10, 0, 0, 0], u_geom: [0, 0, 14.2, 8], u_split: [99, 99, 1, 0],
        u_c0: ELEC, u_c1: ELEC, u_c2: ELEC, u_off: C.none }),
    textRow('hvState', F.u20, 'u20', 1112, 1330, 440, C.ink3),

    /* y 544: electric trip, arrival; miles to go; the sub-lines at y 596 */
    textRow('n544', F.r31, 'r31', 648, 1200, 544, C.ink),
    textRow('u544', F.u20, 'u20', 648, 800, 544, C.ink2),
    textRow('toGo', F.u20, 'u20', 1112, 1300, 574, C.ink2),
    textRow('sub596', F.u20, 'u20', 350, 1790, 596, C.ink2),

    /* under the dials: fuel, trip | coolant, tyres */
    textRow('n542', F.r36, 'r36', 170, 450, 542, C.ink),
    text('coolant', F.r36, 'r36', 3, 'start', 1430, 542, C.ink, { align: 'left' }),
    textRow('u542', F.u20, 'u20', 170, 1520, 542, C.ink2),
    text('tyreStatus', F.r31, 'r31', 5, 'start', 1610, 542, C.ink2),
    barLeds('fuelBar', 170, 556, 150, 8, C.ink),
    barLeds('coolBar', 1430, 556, 150, 8, C.ink),
];

const lay = {};
layers.filter((l) => l.shader === 'text').forEach((l) => { lay[l.name] = { font: l.font, x: l.x, w: l.w || F[l.font].cw * l.cells }; });

const spec = {
    id: 'perf1c', title: 'Performance 1 · Comfort', family: 'perf1', mode: 'comfort', version: 2, bottom: 646,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm', 'coolantC',
        'tyres', 'outsideC', 'clock', 'tripKm', 'avgL100', 'avgKmh', 'instL100', 'limitKmh', 'cruiseKmh', 'turnDir', 'turnM',
        'road', 'destKm', 'eta', 'evTripKm'],
    params: {
        speedMax: 180, tachMax: 8000, evRpm: 300,
        dial: { t0: +dS.t0.toFixed(5), t1: +dS.t1.toFixed(5) },
        /* the drive meter: -40..120 hp over x 648..1272 */
        power: { zeroX: 804, pxPerHp: 3.9, x1: 1272, engX: 805, min: -40, max: 120 },
        tankL: 59, cool: [50, 130], tyreLowBar: 2.0,
        colors: { ink: C.ink, ink2: C.ink2, ink3: C.ink3, elec: ELEC, calm: CALM, ground: C.ground },
        fonts: G.fontParams(F), lay,
    },
    fonts: {},
    paths: {
        speedDial: dS.spec,
        /* the rev counter's field: the speedometer's moved 1260 px (its outward reach for the cruise pointer unused) */
        tachDial: { copy: 'speedDial', at: [dS.spec.rect[0] + TX - SX, dS.spec.rect[1]] },
        arrow: { path: arrowPath, inward: 1, rect: [784, 20, 34, 45], maxd: 4, ends: true },
    },
    layers,
};
Object.keys(F).forEach((k) => { spec.fonts[k] = fontSpec(F[k], '../perf1/fonts/'); });
G.write(__dirname, spec);
console.log('layers', layers.length + 1, 'speed rect', dS.spec.rect, 
    'fonts', Object.keys(F).map((k) => k + ' ' + F[k].cw + 'x' + F[k].ch).join(', '));
