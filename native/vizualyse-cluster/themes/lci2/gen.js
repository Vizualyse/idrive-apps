// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json and geom.js for the "LCI inspired 2" family from the
 * mockup's own geometry (lci-opus/index.html): the octagonal lens, the two
 * L-shaped flank bands that follow it 24 px outside, the shift row along its
 * top edge, the power split, the tyre map and the readout rows. art.html
 * draws the static parts from the same numbers (geom.js), the layers here
 * draw what moves.
 *   node themes/lci2/gen.js            Sport (lci2)
 * The Comfort counterpart (lci2c) reuses the shared pieces exported below.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { flatten, measure } = require('../../tools/field.js');

const W = 1920;
const R2 = (v) => Math.round(v * 100) / 100;
const lerp = (a, b, t) => a + (b - a) * t;
const lengthOf = (pieces) => { const c = measure(flatten(pieces, 1)); return c[c.length - 1]; };

/* ---- colours (DESIGN.md) ---- */
const hex = (h, a) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a == null ? 1 : a]
    .map((v) => Math.round(v * 1000) / 1000);
const C = {
    ink: hex('#eef3ff'), ink2: hex('#9aa8c4'), ink3: hex('#5c6984'), speed: hex('#8fc4ff'), rev: hex('#ff7a26'),
    red: hex('#ff2e3e'), redDim: hex('#3a0d14'), elec: hex('#2fd0ff'), cold: hex('#5c95ff'), ok: hex('#67dfa0'),
    warm: hex('#ffb02e'), hot: hex('#ff3b45'), amber: hex('#ffb21f'), orange: hex('#ff6a1a'), unlit: hex('#141a26'),
    track: hex('#141b29'), box: hex('#03050b'), none: [0, 0, 0, 0],
};

/* ---- the band: the mockup's spAt polyline; the tach is its mirror image ---- */
const BAND = [[650, 604], [490, 604], [336, 450], [336, 182], [490, 28], [560, 28]];
const bandPath = BAND.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]);
const BAND_LEN = lengthOf(bandPath);
/* how far out the scale numerals reach (the brighten), and in to the lens edge (24) */
const REACH = 70;
const bandRect = [266, 0, 662 - 266, 646];

/* the mockup's speed scale: stops at eighths of the band */
const SPD = [0, 20, 40, 60, 80, 100, 130, 160, 200];
const speedMap = SPD.map((v, i) => [v, i / 8]);
const tachMap = [[0, 0], [8000, 1]];

/* ---- Saira (OFL; the mockup's embedded latin subset) at 87.5% width: an instance
 * of its wdth axis (SairaSemiCondensed.woff2); labels and units at normal width.
 * Ascent 1.135 em, descent 0.439 em: a glyph's baseline sits at
 * h/2 + 0.348 size + dy in its cell. ---- */
const SC = 'SairaSemiCondensed.woff2', SN = 'Saira-latin.woff2';
const EM = ' ', EN = ' ';
function font(file, size, weight, cellW, glyphs, tracking) {
    const h = Math.round(size * 0.8) + 4;
    const want = h - Math.round(size * 0.06) - 2;            /* the baseline in the cell */
    const dy = Math.round(want - (h / 2 + 0.348 * size));
    const f = { file, family: 'Saira', weight, size, cell: [cellW, h], dy, glyphs };
    if (tracking) f.tracking = tracking;
    return f;
}
const FONTS = {
    display: font(SC, 132, 600, 76, '0123456789 -', -1.32),
    gear: font(SC, 150, 600, 96, '0123456789-N', -1.5),
    power: font(SC, 40, 500, 24, '0123456789 -'),
    mid: font(SC, 30, 500, 31, '0123456789 .-−LR' + EN + EM),
    clock: font(SC, 26, 500, 16, '0123456789:- '),
    body: font(SC, 18, 500, 16, '0123456789 -%°Cmi−'),
    strip: font(SC, 17, 700, 12, '12345678'),
    unit: font(SN, 15, 400, 15, '0123456789 -°Cmi−'),
    label: font(SN, 13, 500, 15, 'ELCTRIGN ', 1.82),
};
const baseIn = (f) => FONTS[f].cell[1] / 2 + 0.348 * FONTS[f].size + FONTS[f].dy;
/* a text layer from its baseline and its anchor (right end, left start or centre) */
function text(name, f, cells, align, ax, by, color) {
    const w = FONTS[f].cell[0] * cells;
    const x = align === 'right' ? ax - w : align === 'center' ? ax - w / 2 : ax;
    const l = { name, shader: 'text', font: f, x: Math.round(x), y: Math.round(by - baseIn(f)), cells, align };
    if (color) l.uniforms = { u_color: color };
    return l;
}

/* Advances measured in Chrome (Saira, the mockup's sizes); the build measures
 * its own (whole pixels) for the layers, these place the static units. */
const ADV = {
    power: { d: 22.17 }, mid: { d: 16.63, '.': 6.73, ' ': 6.48, R: 17.59 },
    unit: { p: 8.86, s: 7.5, i: 3.81, h: 9 },
};
const unitW = (s) => s.split('').reduce((n, c) => n + ADV.unit[c], 0);
const midW = (s) => s.split('').reduce((n, c) => n + (/\d/.test(c) ? ADV.mid.d : ADV.mid[c]), 0);

/* ---- the anchors the art and the layers share ---- */
const U = {};
U.engR = 712 + 3 * ADV.power.d;  U.engHp = U.engR + 6;          /* 3 digits, as at full throttle */
U.elR = 896 + 2 * ADV.power.d;   U.elHp = U.elR + 6;             /* 2 digits, as the mockup's 52 */
U.sysHp = 1208 - unitW('hp');    U.sysR = U.sysHp - 6;
U.socR = 712 + 2 * ADV.mid.d;    U.socU = U.socR + 4;
U.boostR = 852 + midW('18.1');   U.boostU = U.boostR + 4;
U.glatR = 976 + midW('R 0.06');  U.glatU = U.glatR + 4;
U.glongR = 1100 + midW('0.44');  U.glongU = U.glongR + 4;
U.psiL = 884 - unitW('psi');     U.psiLR = U.psiL - 4;           /* FL/RL: "36.3 psi" ends at 884 */
U.psiRV = 1036;                  U.psiR = 1036 + midW('36.2') + 4;
Object.keys(U).forEach((k) => { U[k] = R2(U[k]); });

/* gear: "M" (64 px) + 2 + the numeral (150 px), centred at 1403 as one text */
const M_W = 49.86, G_W = 83.25 - 1.5;
const gearX = R2(1403 - (M_W + 2 + G_W) / 2 + M_W + 2);
const mX = R2(gearX - 2 - M_W);

/* shift lights: 12 parallelograms 30 wide (36 with the 6 px slant), 42 pitch, y 68..84 */
const SHIFT = { x: 705, y: 68, w: 510, h: 16 };
/* the upshift chevron: 1386,236 1403,220 1420,236, 4 px: two leaning lights */
const CHEV = (() => {
    const h = 21, lean = h * 17 / 16, cw = 17, w = 2 * cw + lean;
    return { x: Math.round(1394.5 - (lean / 2 + cw / 2)), y: 217, w: Math.round(w), h, lean: R2(lean), lw: 5.8 };
})();

function sport() {
    const P = (name, extra) => Object.assign({ name, shader: 'gauge', field: 'band' }, extra);
    const bandU = (fill) => ({
        u_v: [0, 0, 2, 1], u_band: [-5.5, 6.5, -9, 9], u_shape: [1, 1.5, 1.5, 1],
        u_fill: fill, u_red: C.none, u_glow: [0, 0, 0, 30], u_needle: C.ink,
        u_seg: [0, 0, +(0.6 / BAND_LEN).toFixed(5), 1], u_pool: [0, 0, 0, 0], u_look: [REACH, 0.65, 1, 0],
    });
    const lensU = () => ({
        u_v: [+(1 - 1 / BAND_LEN).toFixed(5), 0, 2, 1], u_band: [22.5, 25.5, 0, 0], u_shape: [1, 0, 0, 1],
        u_fill: C.none, u_red: C.none, u_glow: C.none, u_needle: C.none,
        u_seg: [0, 0, +(1 / BAND_LEN).toFixed(5), 1], u_pool: [0, 0, 0, 0], u_look: [0, 0, 2, 0],
    });
    const layers = [
        P('speed', { uniforms: bandU(C.speed) }),
        P('tach', { field: 'tachBand', uniforms: bandU(C.rev) }),
        P('lensL', { art: false, uniforms: lensU() }),
        P('lensR', { field: 'tachBand', art: false, uniforms: lensU() }),
        { name: 'lensTop', shader: 'rect', x: 556, y: 50, w: 808, h: 3, uniforms: { u_color: C.red } },
        { name: 'lensBot', shader: 'rect', x: 648, y: 579, w: 624, h: 3, uniforms: { u_color: C.red } },
        { name: 'shift', shader: 'leds', x: SHIFT.x, y: SHIFT.y, w: SHIFT.w, h: SHIFT.h, uniforms: {
            u_led: [12, 0, 0, 1], u_geom: [0, 0, 30, 16], u_split: [2, 4, 0, 0], u_lean: [6, 0, 0, 0],
            u_c0: C.amber, u_c1: C.orange, u_c2: C.red, u_off: C.none } },
        { name: 'chevron', shader: 'gauge', field: 'chevron', art: false, uniforms: {
            u_v: [1, 0, 2, 1], u_band: [-2, 2, 0, 0], u_shape: [1, 0, 0, 1], u_fill: C.none, u_red: C.none, u_glow: C.none,
            u_needle: C.none, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0], u_look: [0, 0, 2, 0] } },
        { name: 'modeMask', shader: 'rect', x: Math.floor(mX) - 2, y: 306, w: 54, h: 52, uniforms: { u_color: C.box } },
        /* fuel: ten segments 14 x 8 on a 17 pitch; oil: a continuous bar; battery: the glyph's fill */
        { name: 'fuelSegs', shader: 'leds', x: 471, y: 480, w: 170, h: 8, uniforms: {
            u_led: [10, 0, 0, 0], u_geom: [0, 0, 14, 8], u_split: [99, 99, 0, 0], u_c0: C.ink2, u_c1: C.ink2, u_c2: C.ink2, u_off: C.track } },
        { name: 'oilBar', shader: 'leds', x: 1280, y: 480, w: 168, h: 8, uniforms: {
            u_led: [168, 0, 0, 0], u_geom: [0, 0, 1, 8], u_split: [999, 999, 0, 0], u_c0: C.ink, u_c1: C.ink, u_c2: C.ink, u_off: C.none } },
        { name: 'socBar', shader: 'leds', x: 782, y: 538, w: 36, h: 6, uniforms: {
            u_led: [36, 0, 0, 0], u_geom: [0, 0, 1, 6], u_split: [999, 999, 0, 0], u_c0: C.elec, u_c1: C.elec, u_c2: C.elec, u_off: C.none } },
        /* power: engine then electric in one row of 1 px cells (colour at the engine's end); regen a cyan hatch */
        { name: 'power', shader: 'leds', x: 712, y: 176, w: 496, h: 12, uniforms: {
            u_led: [496, 0, 0, 0], u_geom: [0, 0, 1, 12], u_split: [0, 9999, 0, 0], u_lean: [0, 0, 0, 0],
            u_c0: C.rev, u_c1: C.elec, u_c2: C.elec, u_off: C.none } },
        /* tyre pads: front and rear pairs, 14 x 38, 106 apart */
        { name: 'padsF', shader: 'leds', x: 854, y: 280, w: 212, h: 38, uniforms: {
            u_led: [2, 0, 0, 0], u_geom: [0, 0, 14, 38], u_split: [1, 99, 3, 0], u_c0: C.cold, u_c1: C.cold, u_c2: C.cold, u_off: C.track } },
        { name: 'padsR', shader: 'leds', x: 854, y: 396, w: 212, h: 38, uniforms: {
            u_led: [2, 0, 0, 0], u_geom: [0, 0, 14, 38], u_split: [1, 99, 3, 0], u_c0: C.cold, u_c1: C.cold, u_c2: C.cold, u_off: C.track } },
        text('spd', 'display', 3, 'center', 517, 344),
        text('gear', 'gear', 2, 'left', gearX, 356),
        text('gearOn', 'strip', 1, 'center', 1403, 398),
        text('fuelPct', 'body', 5, 'right', 640, 467),
        text('range', 'body', 7, 'right', 640, 541),
        text('oil', 'body', 6, 'right', 1448, 467),
        text('cool', 'body', 6, 'right', 1448, 541),
        text('engHp', 'power', 3, 'right', U.engR, 160),
        text('elHp', 'power', 3, 'right', U.elR, 160, C.elec),
        text('sysHp', 'power', 3, 'right', U.sysR, 160),
        text('elecLbl', 'label', 8, 'left', 896, 122, C.ink2),
        text('psiF', 'mid', 16, 'left', 800, 300),
        text('psiR', 'mid', 16, 'left', 800, 416),
        text('tempFL', 'body', 6, 'right', 884, 328),
        text('tempFR', 'body', 6, 'left', 1036, 328),
        text('tempRL', 'body', 6, 'right', 884, 444),
        text('tempRR', 'body', 6, 'left', 1036, 444),
        text('soc', 'mid', 3, 'right', U.socR, 548),
        text('boost', 'mid', 5, 'right', U.boostR, 548),
        text('glat', 'mid', 6, 'right', U.glatR, 548),
        text('glong', 'mid', 5, 'right', U.glongR, 548),
        text('clock', 'clock', 5, 'left', 150, 626),
        text('otemp', 'unit', 6, 'left', 226, 626, C.ink2),
        text('odo', 'unit', 10, 'right', 1770, 600, C.ink2),
    ];
    return {
        id: 'lci2', title: 'LCI inspired 2', family: 'lci2', mode: 'sport', version: 2, bottom: 646,
        signals: ['kmh', 'rpm', 'gear', 'gearMode', 'throttle', 'engineHp', 'elecHp', 'socPct', 'fuelPct', 'rangeKm',
            'oilC', 'coolantC', 'boostBar', 'tyres', 'gLat', 'gLon', 'clock', 'outsideC', 'odoKm'],
        params: {
            speedMap, tachMap, shiftFrom: 4800, shiftCue: 6400, revWarm: 3000,
            gearStrip: { x: 1403, pitch: 24, cell: FONTS.strip.cell[0] },
            psi: { lEnd: U.psiLR, rStart: U.psiRV },
            colors: C,
        },
        fonts: FONTS,
        paths: {
            band: { path: bandPath, inward: -1, rect: bandRect, maxd: REACH, ends: true, step: 1 },
            tachBand: { mirror: 'band' },
            /* the upshift chevron, 4 px: 1386,236 1403,220 1420,236 */
            chevron: { path: [['M', 1386, 236], ['L', 1403, 220], ['L', 1420, 236]], inward: 1, rect: [1381, 215, 44, 25], maxd: 3, step: 1 },
        },
        layers,
    };
}

function write(dir, spec, geom) {
    /* compact JSON: one line per path piece list and per small array */
    const json = JSON.stringify(spec, null, 1)
        .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']');
    fs.writeFileSync(path.join(dir, 'theme.src.json'), json + '\n');
    fs.writeFileSync(path.join(dir, 'geom.js'), '// written by gen.js: the numbers art.html shares with the layers\n' +
        'window.LCI = ' + JSON.stringify(geom) + ';\n');
    console.log(spec.id + ': ' + (spec.layers.length + 1) + ' layers, band length ' + BAND_LEN.toFixed(1));
}

module.exports = { C, hex, BAND, bandPath, BAND_LEN, REACH, bandRect, SPD, speedMap, tachMap, FONTS, font, text, ADV, U, gearX, mX, SHIFT, CHEV, write, sport, EM, EN };

if (require.main === module) {
    const spec = sport();
    write(__dirname, spec, { cue: spec.params.shiftCue, U, gearX, mX });
}
