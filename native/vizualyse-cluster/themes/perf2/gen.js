// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes a Performance 2 theme's theme.src.json and geom.js (the numbers
 * art.html draws with) from the Performance mockups' own geometry: the two
 * open-bottomed 270 degree dials (centres 340 / 1580, y 300, track radius
 * 240), the bars, the car plan or the guidance, and the readouts at the
 * places the mockups' layout puts them (measured from their DOM in Chrome).
 *   node themes/perf2/gen.js            Sport   -> themes/perf2  (perf2)
 *   node themes/perf2/gen.js comfort    Comfort -> themes/perf2c (perf2c), art.html copied from here
 * then node tools/theme_build.js themes/<id> --keep, twice the first time: the
 * covers take their colour from the last build's art.preview.png.
 *
 * The two dials share one field: the tach is the speedometer moved right
 * ({ "copy" }), not mirrored (both run clockwise from 135 degrees).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { flatten, measure } = require('../../tools/field.js');

const R2 = (v) => Math.round(v * 100) / 100;
const R5 = (v) => Math.round(v * 1e5) / 1e5;
const hex = (h, a) => [1, 3, 5].map((i) => R2(parseInt(h.slice(i, i + 2), 16) / 255)).concat([a == null ? 1 : a]);
const lengthOf = (pieces) => { const c = measure(flatten(pieces, 1)); return c[c.length - 1]; };

/* ---- the mockups' palette ---- */
const PAL = {
    ground: '#04060a', ink: '#eef2f6', ink2: '#9ba6b2', ink3: '#7a8592', cool: '#d9e6f2', well: '#0d1218',
    track: '#18202a', trackDim: '#121820', red: '#ff3b2f', redDeep: '#b8180f', amber: '#ffb224', blue: '#3f9cff',
    hatch: '#2a74c4', flashOff: '#2a0d0b', signInk: '#0a0d12',
};
const C = {};
Object.keys(PAL).forEach((k) => { C[k] = hex(PAL[k]); });
C.none = [0, 0, 0, 0];
/* the glow's own light, added; the brighten (u_look.y) does the rest */
C.glow = [0.07, 0.08, 0.09, 1];
C.glowRed = [0.16, 0.03, 0.02, 1];

/* ---- fonts: Barlow Semi Condensed; a glyph's baseline sits at h/2 + 0.4 size + dy in its cell ---- */
const F600 = '../fonts/BarlowSemiCondensed-600.woff2', F700 = '../perf2/BarlowSemiCondensed-700.woff2';
function font(size, cellW, glyphs, opts) {
    opts = opts || {};
    const b = Math.ceil(0.76 * size) + 2, h = b + Math.ceil((opts.desc || 0.08) * size) + 1;
    return { file: opts.file || F600, weight: opts.weight || 600, size, cell: [cellW, h], dy: R2(b - h / 2 - 0.4 * size),
        glyphs, tracking: opts.tracking, bl: b };
}

/* ---- the variants ---- */
const VARIANTS = {
    sport: {
        id: 'perf2', title: 'Performance 2', family: 'perf2', mode: 'sport', outR: 262,
        /* the bench drive shifts up at 6,600: the cue and lamps end at 6,400 so they show */
        shiftRpm: 6400, lampFrom: 4600, redRpm: 7000, maxRpm: 8000, maxMph: 180,
    },
    comfort: {
        id: 'perf2c', title: 'Performance 2 · Comfort', family: 'perf2', mode: 'comfort', outR: 280,
        redRpm: 7000, quietRpm: 4000, maxRpm: 8000, maxMph: 180,
        /* the demand bar: -0.5 (charge) .. 1 (power) as hp, the eco window to 0.45 */
        demandHp: 250, eco: 0.45,
    },
};

function gen(V) {
    const OUT = path.join(__dirname, '..', V.id);
    fs.mkdirSync(OUT, { recursive: true });
    const comfort = V.mode === 'comfort';

    /* ---- dials ---- */
    const R = 240, SPD = [340, 300], TAC = [1580, 300];
    const dialPath = [['A', SPD[0], SPD[1], R, 135, 405]];
    const dialLen = lengthOf(dialPath);
    /* the field: out to the bezel (258) and its flash, or the cruise notch (278); 90 in (ticks, numerals at 176) */
    const OUTR = V.outR;
    const dialRect = [SPD[0] - OUTR, SPD[1] - OUTR, OUTR * 2, Math.ceil(SPD[1] + OUTR * Math.SQRT1_2 + 2) - (SPD[1] - OUTR)];

    const text = (FONTS) => (name, f, cells, align, x, baseline, color) => {
        const F = FONTS[f], w = F.cell[0] * cells;
        const lx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
        return { name, shader: 'text', font: f, cells, align, x: Math.round(lx), y: Math.round(baseline - F.bl), uniforms: { u_color: color || C.ink } };
    };
    const rect = (name, x, y, w, h, r, color, ring_) => ({ name, shader: 'rect', x, y, w, h,
        uniforms: { u_shape: [0, 0, r, ring_ ? ring_[0] : 0], u_color: color, u_ring: ring_ ? ring_[1] : C.none } });
    const leds = (name, x, y, w, h, u) => ({ name, shader: 'leds', x, y, w, h, uniforms: u });
    /* the dials: a 12 px trail on the track (d -6..6), the glow inward over ticks and numerals
     * (added, and brightening the art), the needle from 46 in to 12 out */
    const dialU = (fill) => ({
        u_val: [0, 0, 2, 0.01], u_band: [-6, 6, -12, 46], u_shape: [92, 3, 1.2, 0.8],
        u_fill: fill, u_red: C.none, u_glow: C.glow, u_needle: C.none,
        u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0], u_look: [0.25, 2, 1, 0],
    });
    const off = { u_look: [0, 0, 2, 0], u_shape: [1, 0, 0, 0], u_glow: C.none, u_needle: C.none };
    const fuelLeds = leds('fuel', 221, 528, 239, 10, { u_led: [24, 0, 0, 0], u_geom: [0, 0, 6.96, 10], u_split: [99, 99, 1, 0],
        u_c0: C.cool, u_c1: C.cool, u_c2: C.cool, u_off: C.track });
    const hvLeds = leds('hv', 659, 599, 320, 8, { u_led: [24, 0, 0, 0], u_geom: [0, 0, 10.33, 8], u_split: [99, 99, 1, 0],
        u_c0: C.blue, u_c1: C.blue, u_c2: C.blue, u_off: C.track });

    let FONTS, layers, paths, params, signals, covers;
    if (!comfort) {
        /* ramp: lamps fill in 8 rings from lampFrom to the shift point: 0-2 white, 3-5 amber, 6-7 red;
         * the trail switches colour where the rings do */
        const ring = (k) => V.lampFrom + (V.shiftRpm - V.lampFrom) * k / 8;
        /* bars: the power split (660..1260, y 191, -100..500 hp), then up and along the boost bar
         * (1260 -> 1110, y 166, -1..2 bar, so it runs right to left) */
        const barsPath = [['M', 660, 191], ['L', 1260, 191], ['L', 1260, 166], ['L', 1110, 166]];
        const barsLen = lengthOf(barsPath);
        FONTS = {
            speed: font(140, 72, '0123456789- ', { tracking: -2.8 }),
            gear: font(164, 112, '0123456789MDNPRS- '),
            p60: font(60, 32, '0123456789−- '),
            v40: font(40, 22, '0123456789.−- '),
            v30: font(30, 17, '0123456789.,- ', { desc: 0.2 }),
            v26: font(26, 14, '0123456789:−- '),
            v22: font(22, 13, '0123456789+−- '),
            v20: font(20, 12, '0123456789.- '),
            status: font(16, 15, 'DEPLOYRGNH- ', { file: F700, weight: 700, tracking: 2.24 }),
        };
        const T = text(FONTS);
        layers = [
            { name: 'speed', shader: 'gauge', field: 'speed', uniforms: Object.assign(dialU(hex(PAL.cool, 0.25)), { u_red: hex(PAL.cool, 0.8), u_needle: C.red }) },
            { name: 'tach', shader: 'gauge', field: 'tach', uniforms: Object.assign(dialU(hex(PAL.cool, 0.45)), { u_red: C.amber }) },
            /* the red stage of the trail, the bezel when the row flashes, and the needle on top */
            { name: 'tachRed', shader: 'gauge', field: 'tach', art: false, uniforms: Object.assign({}, off, {
                u_val: [0, 0, 2, 0], u_band: [-6, 6, -12, 46], u_shape: [1, 3, 1.2, 0], u_fill: C.none, u_red: C.red, u_needle: C.red,
                u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0] }) },
            /* power split (engine then electric deploy; regen hatched left of zero) and boost */
            { name: 'power', shader: 'gauge', field: 'bars', uniforms: Object.assign({}, off, {
                u_val: [0, 0, 2, 0], u_band: [-6, 6, 0, 0], u_fill: C.cool, u_red: C.blue, u_seg: [0, 0, 0, 1] }) },
            { name: 'boost', shader: 'gauge', field: 'bars', art: false, uniforms: Object.assign({}, off, {
                u_val: [0, 0, 2, 0], u_band: [-3, 3, 0, 0], u_fill: C.cool, u_red: C.cool, u_seg: [0, 0, 0, 1] }) },
            /* 15 lamps 18 px on a 24 px pitch, filling from both ends, halo 12 */
            leds('shift', 780, 21, 360, 42, { u_led: [15, 0, 0, 1], u_geom: [0, 0, 18, 18], u_split: [3, 6, 3, 12],
                u_c0: C.cool, u_c1: C.amber, u_c2: C.red, u_off: C.trackDim }),
            /* covers the art's SHIFT cue until the cue */
            rect('cueCover', 1524, 177, 112, 32, 0, C.ground),
            fuelLeds, hvLeds,
            /* wheels: a pair a layer, each lamp its own colour (c0, c1); transparent shows the art's cold outline */
            leds('wheelsF', 886, 306, 148, 32, { u_led: [2, 2, 0, 0], u_geom: [0, 0, 12, 32], u_split: [1, 2, 3, 0],
                u_c0: C.none, u_c1: C.none, u_c2: C.none, u_off: C.none }),
            leds('wheelsR', 886, 398, 148, 32, { u_led: [2, 2, 0, 0], u_geom: [0, 0, 12, 32], u_split: [1, 2, 3, 0],
                u_c0: C.none, u_c1: C.none, u_c2: C.none, u_off: C.none }),
            rect('oilMark', 1488, 574, 3, 14, 1, C.ink),
            rect('coolMark', 1675, 574, 3, 14, 1, C.ink),
            rect('gDot', 951, 359, 18, 18, 9, C.ink, [2.5, C.ground]),
            T('speedText', 'speed', 3, 'center', 340, 332),
            T('gearText', 'gear', 3, 'center', 1580, 367),
            T('rpmText', 'v30', 5, 'right', 1596.7, 403),
            T('rangeText', 'v40', 4, 'right', 321.9, 614),
            T('oilText', 'v40', 3, 'right', 1470.8, 562),
            T('coolText', 'v40', 3, 'right', 1640.6, 562),
            /* the clock and the outside temperature on one layer, up to the art's degree sign */
            T('topText', 'v26', 12, 'right', 724.4, 52.5),
            T('powerText', 'p60', 4, 'right', 751.3, 166),
            T('boostText', 'v40', 5, 'right', 1227.9, 150),
            T('engText', 'v22', 3, 'right', 772.2, 233),
            T('eleText', 'v22', 4, 'right', 1240.3, 233, C.blue),
            T('psiFL', 'v30', 4, 'right', 815.2, 323),
            T('psiFR', 'v30', 4, 'left', 1080, 323),
            T('psiRL', 'v30', 4, 'right', 815.2, 429),
            T('psiRR', 'v30', 4, 'left', 1080, 429),
            T('tempFL', 'v20', 3, 'right', 822.4, 350),
            T('tempFR', 'v20', 3, 'left', 1080, 350),
            T('tempRL', 'v20', 3, 'right', 822.4, 456),
            T('tempRR', 'v20', 3, 'left', 1080, 456),
            T('gText', 'v20', 4, 'left', 950.8, 496),
            T('hvText', 'v40', 3, 'right', 700.6, 587),
            T('hvState', 'status', 6, 'right', 977.1, 541, C.blue),
        ];
        covers = ['cueCover'];
        paths = {
            speed: { path: dialPath, inward: -1, rect: dialRect, maxd: 90 },
            tach: { copy: 'speed', at: [TAC[0] - OUTR, dialRect[1]] },
            bars: { path: barsPath, inward: 1, rect: [656, 159, 608, 40], maxd: 7 },
        };
        signals = ['kmh', 'rpm', 'gear', 'gearMode', 'throttle', 'engineHp', 'elecHp', 'socPct', 'fuelPct', 'rangeKm',
            'oilC', 'coolantC', 'boostBar', 'tyres', 'outsideC', 'gLat', 'gLon', 'clock'];
        params = {
            shiftRpm: V.shiftRpm, lampFrom: V.lampFrom, amberRpm: ring(3), redStageRpm: ring(6), topGear: 8,
            bars: { len: R2(barsLen), pMin: -100, pMax: 500, pT1: R5(600 / barsLen), bMin: -1, bMax: 2,
                bT0: R5(625 / barsLen), bT1: R5((625 + 150) / barsLen) },
            oil: { x: 1410, w: 150, lo: 50, hi: 150 }, cool: { x: 1600, w: 150, lo: 50, hi: 130 },
            g: { cx: 960, cy: 368, k: 80, max: 1.25 }, tyreCold: 70, tyreHot: 95,
        };
    } else {
        /* the demand bar (660..1260, y 191): -0.5 .. 1 */
        const barsPath = [['M', 660, 191], ['L', 1260, 191]];
        /* the turn arrow, right-hand (the mockup's 76 px svg at 660, 270); mirrored for a left turn */
        const A = (x, y) => [660 + x, 270 + y];
        const arrowPath = [['M'].concat(A(22, 72)), ['L'].concat(A(22, 34)), ['L'].concat(A(60, 34)), ['L'].concat(A(44, 18)),
            ['L'].concat(A(60, 34)), ['L'].concat(A(44, 50))];
        FONTS = {
            speed: font(140, 72, '0123456789- ', { tracking: -2.8 }),
            gear: font(112, 72, 'DMSPRN- '),
            p60: font(60, 32, '0123456789.- '),
            v48: font(48, 26, '0123456789.,- '),
            v40: font(40, 27, '0123456789.,-OKLW '),
            v26: font(26, 14, '0123456789:,−- ', { desc: 0.2 }),
            /* road names, the cruise word, the arrival, the tyre pressures: one 20 px alphabet */
            t20: font(20, 20, 'jABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghiklmnopqrstuvwxyz0123456789 .,:\'-·/&()', { desc: 0.24 }),
            lbl: font(16, 18, 'ABCDEGHILMNOPRTVWY0123456789- ', { file: F700, weight: 700, tracking: 2.24 }),
        };
        const T = text(FONTS);
        layers = [
            { name: 'speed', shader: 'gauge', field: 'speed', uniforms: Object.assign(dialU(hex(PAL.cool, 0.2)),
                { u_red: hex(PAL.cool, 0.7), u_needle: C.ink, u_look: [0.25, 1.6, 1, 0], u_shape: [92, 3, 1.2, 0.6] }) },
            /* the cruise set speed: a wedge outside the bezel (r 262..278), the gauge's needle tapering inward */
            { name: 'cruise', shader: 'gauge', field: 'speed', art: false, uniforms: Object.assign({}, off, {
                u_val: [0, 0, 2, 0], u_band: [0, 0, -38, -22], u_shape: [1, 5.6, 0.3, 0], u_fill: C.none, u_red: C.none, u_needle: C.cool,
                u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0] }) },
            { name: 'tach', shader: 'gauge', field: 'tach', uniforms: Object.assign(dialU(hex(PAL.cool, 0.2)),
                { u_red: hex(PAL.cool, 0.7), u_needle: C.ink, u_look: [0.25, 1.6, 1, 0], u_shape: [92, 3, 1.2, 0.6] }) },
            { name: 'demand', shader: 'gauge', field: 'bars', uniforms: Object.assign({}, off, {
                u_val: [0, 0, 2, 0], u_band: [-6, 6, 0, 0], u_fill: C.cool, u_red: C.blue, u_seg: [0, 0, 0, 1] }) },
            { name: 'arrowTurn', shader: 'gauge', field: 'arrow', art: false, uniforms: Object.assign({}, off, {
                u_val: [1, 0, 2, 0], u_band: [-3.5, 3.5, 0, 0], u_fill: C.ink, u_red: C.ink, u_seg: [0, 0, 0, 1] }) },
            /* the straight-on arrow: a stem and a chevron head (two leaning lamps) */
            rect('arrowStem', 694.5, 284, 7, 61.5, 0, C.ink),
            leds('arrowHead', 674, 279, 54, 24, { u_led: [2, 2, 0, 0], u_geom: [0, 0, 9.9, 24], u_split: [99, 99, 0, 0],
                u_c0: C.ink, u_c1: C.ink, u_c2: C.ink, u_off: C.none, u_lean: [18, 0, 1, 0] }),
            /* covers the art's ELECTRIC light until the engine is off */
            rect('evCover', 1490, 182, 180, 26, 0, C.ground),
            fuelLeds, hvLeds,
            rect('coolMark', 1484, 574, 3, 14, 1, C.ink),
            T('speedText', 'speed', 3, 'center', 340, 332),
            T('limitText', 'v26', 3, 'center', 340, 441, C.signInk),
            T('cruiseText', 't20', 6, 'left', 1128, 50),
            T('gearL', 'gear', 1, 'right', 1591.3, 330),
            T('gearN', 'p60', 2, 'left', 1601.3, 330, C.ink2),
            /* rpm at 26 px (30 in the mockup): a ninth font would be a thirteenth asset */
            T('rpmText', 'v26', 5, 'right', 1596.7, 385),
            T('rangeText', 'v40', 4, 'right', 321.9, 614),
            T('coolText', 'v40', 3, 'right', 1450.6, 562),
            T('tyresWord', 'v40', 3, 'left', 1600, 562),
            T('tyrePsi', 't20', 16, 'left', 1600, 591, C.ink2),
            T('topText', 'v26', 12, 'right', 818, 52.5),
            T('mpgText', 'p60', 4, 'right', 765.8, 166),
            T('zoneC', 'lbl', 6, 'left', 660, 229, C.ink3),
            T('zoneE', 'lbl', 3, 'center', 950, 229, C.ink3),
            T('zoneP', 'lbl', 5, 'right', 1260, 229, C.ink3),
            /* the distance from the column's edge; the unit moved after it (the logic, from distAdv) */
            T('distText', 'v48', 5, 'left', 660, 399),
            T('distUnit', 't20', 2, 'left', 726.3, 399, C.ink2),
            T('roadText', 't20', 16, 'left', 660, 433.5),
            T('etaText', 't20', 13, 'left', 706, 469.3),
            T('hvText', 'v40', 3, 'right', 700.6, 587),
            T('evRangeText', 'v26', 3, 'right', 774.7, 587),
            T('hvState', 'lbl', 8, 'right', 977.1, 541, C.blue),
            T('tripText', 'v40', 5, 'right', 1095.6, 587),
            T('avgText', 'lbl', 10, 'right', 1260, 541, C.ink2),
        ];
        covers = ['evCover'];
        paths = {
            speed: { path: dialPath, inward: -1, rect: dialRect, maxd: 90 },
            tach: { copy: 'speed', at: [TAC[0] - OUTR, dialRect[1]] },
            bars: { path: barsPath, inward: 1, rect: [656, 183, 608, 16], maxd: 7 },
            arrow: { path: arrowPath, inward: 1, rect: [660, 270, 76, 76], maxd: 5, ends: true },
        };
        signals = ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm',
            'coolantC', 'tyres', 'outsideC', 'clock', 'tripKm', 'avgL100', 'avgKmh', 'limitKmh', 'cruiseKmh',
            'turnDir', 'turnM', 'road', 'destKm', 'eta'];
        params = {
            demandHp: V.demandHp, eco: V.eco, bars: { len: R2(lengthOf(barsPath)), dMin: -0.5, dMax: 1 },
            arrowLen: R2(lengthOf(arrowPath)), distAdv: { digit: 24, '.': 12, ',': 11, '-': 17, x: 660, gap: 6 }, cool: { x: 1410, w: 150, lo: 50, hi: 130 }, tyreLowBar: 2.1,
        };
    }

    /* the covers' colour: the art's own under them (from the last build's art.preview.png) */
    const prev = path.join(OUT, 'art.preview.png');
    if (fs.existsSync(prev)) {
        const { readPng } = require('../../tools/png.js');
        const img = readPng(fs.readFileSync(prev));
        covers.forEach((name) => {
            const cv = layers.find((l) => l.name === name);
            const sum = [0, 0, 0];
            let n = 0;
            for (let y = cv.y; y < cv.y + cv.h; y += cv.h - 1) for (let x = cv.x; x < cv.x + cv.w; x += cv.w - 1) {
                const o = (Math.round(y) * img.w + Math.round(x)) * 4;
                for (let k = 0; k < 3; k++) sum[k] += img.rgba[o + k];
                n++;
            }
            cv.uniforms.u_color = sum.map((v) => R2(v / n / 255)).concat([1]);
        });
    }

    const spec = {
        id: V.id, title: V.title, family: V.family, mode: V.mode, version: 2, bottom: 646, signals,
        params: Object.assign({ maxMph: V.maxMph, maxRpm: V.maxRpm, redRpm: V.redRpm, dialLen: R2(dialLen), fuelLowPct: 15, colors: C }, params),
        fonts: {}, paths, layers,
    };
    const gl = layers.find((l) => l.name === 'gearText');
    if (gl) spec.params.gearY = gl.y;
    Object.keys(FONTS).forEach((k) => { const f = Object.assign({}, FONTS[k]); delete f.bl; if (f.tracking == null) delete f.tracking; spec.fonts[k] = f; });

    const json = JSON.stringify(spec, null, 1).replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']');
    fs.writeFileSync(path.join(OUT, 'theme.src.json'), json + '\n');
    /* what art.html draws with; Comfort draws with this folder's art.html */
    const geom = { mode: V.mode, R, SPD, TAC, maxMph: V.maxMph, maxRpm: V.maxRpm, redRpm: V.redRpm, shiftRpm: V.shiftRpm,
        quietRpm: V.quietRpm, eco: V.eco, PAL };
    fs.writeFileSync(path.join(OUT, 'geom.js'), '// written by ../perf2/gen.js\nwindow.GEOM = ' + JSON.stringify(geom) + ';\n');
    if (OUT !== __dirname) fs.copyFileSync(path.join(__dirname, 'art.html'), path.join(OUT, 'art.html'));
    console.log(V.id + ': ' + (layers.length + 1) + ' layers; dial rect ' + dialRect + ', length ' + R2(dialLen));
}

if (require.main === module) gen(VARIANTS[process.argv[2] || 'sport']);
module.exports = { VARIANTS, gen };
