// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for g20i1 (shader library v2) from the mockup's own
 * geometry (the G20 Sport mockup's bracket outlines, mini bars, power bars,
 * shift lights and readouts), so paths, field rectangles, text anchors and
 * the logic's path positions stay in step.
 *   node themes/g20i1/gen_src.js
 * then node tools/theme_build.js themes/g20i1
 *
 * Fields: the speedometer's bracket (the tach mirrors it), the fuel bar (the
 * oil bar mirrors it), the two power bars.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { flatten, measure } = require('../../tools/field.js');

const R = (v) => Math.round(v * 100) / 100;
function unit(x, y) { const m = Math.hypot(x, y) || 1; return [x / m, y / m]; }
function len(pieces) { const c = measure(flatten(pieces)); return c[c.length - 1]; }

/* The mockup's roundedPath(pts, 70) as path pieces, trimmed: the scale
 * starts startAt px along the outline and ends endPad px before its end. */
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

/* The mockup's Mini(): the bar 36 px outside the bracket's lower diagonal,
 * from 0.14 to 0.84 of it. p0 is the low (empty) end. */
function mini(a, b, out) {
    const A = [a[0] + out[0] * 36, a[1] + out[1] * 36], B = [b[0] + out[0] * 36, b[1] + out[1] * 36];
    const along = (k) => [R(A[0] + (B[0] - A[0]) * k), R(A[1] + (B[1] - A[1]) * k)];
    return { p0: along(0.14), p1: along(0.84) };
}

/* speed: a 70 px lead-in along the outline (never lit: the band and the glow
 * start at the scale's 0), so the needle at 0 is a clean line, then the scale */
const SPEED_PTS = [[690, 560], [300, 560], [120, 330], [270, 96], [720, 70]];
const scale = bracket(SPEED_PTS, 290, 40);
const start = scale[0];
const speedPath = [['M', start[1] + 70, start[2]]].concat(scale);
const total = len(speedPath);
const t0 = Math.round(70 / total * 1e6) / 1e6;

/* glow depth: the wedge reaches 112 px in; nothing outward (u_look.x 0),
 * so the field's rectangle needs only the outline's own width outside */
const GLOW = 240, OUT = 6;
const pts = flatten(speedPath);
const bx = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
const by = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
const speedRect = [Math.floor(bx[0] - OUT), Math.max(0, Math.floor(by[0] - OUT)), 0, 0];
speedRect[2] = Math.ceil(bx[1] + 3) - speedRect[0];
speedRect[3] = Math.min(645, Math.ceil(by[1] + OUT)) - speedRect[1];

/* the wedge's trail: the mockup's 14 wedges fade as (1 - k)^2 over 112 px,
 * half strength 33 px back; the shader's smoothstep is half way at TRAIL / 2 */
const TRAIL = 70;

/* fuel: the bar from its low end up (the oil bar mirrors it) */
const fuel = mini([300, 560], [120, 330], [-0.788, 0.616]);
const FUEL = [['M', fuel.p0[0], fuel.p0[1]], ['L', fuel.p1[0], fuel.p1[1]]];
const fuelRect = [Math.floor(Math.min(fuel.p0[0], fuel.p1[0]) - 6), Math.floor(Math.min(fuel.p0[1], fuel.p1[1]) - 6), 0, 0];
fuelRect[2] = Math.ceil(Math.max(fuel.p0[0], fuel.p1[0]) + 6) - fuelRect[0];
fuelRect[3] = Math.ceil(Math.max(fuel.p0[1], fuel.p1[1]) + 6) - fuelRect[1];

/* power bars: the mockup's quadratic strokes, bottom to top */
const ENG = [['M', 800, 420], ['Q', 762, 270, 800, 120]];
const ELE = [['M', 1120, 420], ['Q', 1158, 270, 1120, 120]];
const barLen = len(ENG);

const C = {
    sport: [1, 0.169, 0.11], ember: [0.42, 0.055, 0.031], volt: [0.302, 0.722, 1], amber: [1, 0.627, 0.2],
    ink: [0.965, 0.937, 0.91], line: [1, 0.824, 0.678], dim: [0.659, 0.616, 0.584], track: [0.173, 0.149, 0.141],
};
const a = (c, al) => c.concat([al]);

/* fonts: proportional (v2), each glyph from its cell's left edge; baseline
 * at bl px from the cell's top: (h - 1.2 size) / 2 + size + dy */
const F400 = '../fonts/BarlowSemiCondensed-400.woff2', F500 = '../fonts/BarlowSemiCondensed-500.woff2';
const EM = ' ', EN = ' ';
const fonts = {
    big: { file: F500, weight: 500, size: 170, cell: [100, 136], dy: -8, tracking: -3.4, glyphs: '0123456789 -NPRD', bl: 128 },
    val: { file: F500, weight: 500, size: 30, cell: [32, 28], dy: -2, glyphs: '0123456789 -+.:' + EM + EN, bl: 24 },
    small: { file: F500, weight: 500, size: 24, cell: [26, 24], dy: -1.6, glyphs: '0123456789 -.°' + EM, bl: 20 },
    label: { file: F500, weight: 500, size: 22, cell: [16, 20], dy: -0.8, tracking: 1.32, glyphs: 'ACEGHILNRT -', bl: 18 },
    prefix: { file: F400, weight: 400, size: 64, cell: [44, 52], dy: -1.6, glyphs: 'MDS ', bl: 50 },
};
/* a text layer w px wide whose right edge (or left edge, or centre) sits at
 * x, baseline y */
function text(name, font, cells, w, x, y, align, color) {
    const f = fonts[font];
    const lx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    return { name, shader: 'text', font, x: Math.round(lx), y: Math.round(y - f.bl), w, cells, align, uniforms: { u_color: color || a(C.ink, 1) } };
}
function rect(name, x, y, w, h, r, color, ring) {
    return { name, shader: 'rect', x, y, w, h, uniforms: { u_shape: [0, 0, r, ring || 0], u_color: color } };
}
const off = [0, 0, 0, 0];

/* the bracket gauges: band 22 px wide 16 px inside the outline (d 5..27), in
 * segments whose 3 px gaps fall on the ticks (so the ticks show across the
 * lit band, as in the mockup); a 5 px needle 40 px long; the red wedge added
 * to the art (numerals and ticks brighten under it); a pool of red at the
 * needle for the mockup's hot stroke under it */
const bracketU = (segs) => ({
    u_val: [t0, 0, 2, R(TRAIL / total)], u_band: [5, 27, 0, 40], u_shape: [GLOW, 2.5, 2.5, 0],
    u_fill: a(C.sport, 0.82), u_red: a(C.sport, 0.82), u_glow: a(C.sport, 0), u_needle: a(C.ink, 1),
    u_seg: [segs, 2.5, t0, 1], u_pool: [16, 0.9, 20, 0],
    /* no outward reach; the art under the wedge brightened x(1 + 3 glow),
     * so the 0.58-grey numerals turn white as the needle passes */
    u_look: [0, 3, 2, 0],
});
const barU = (fill, startT) => ({
    u_val: [startT, 0, 2, 0], u_band: [-7, 7, 0, 0], u_shape: [1, 0, 0, 0],
    u_fill: fill, u_red: fill, u_glow: off, u_needle: off, u_seg: [0, 0, startT, 1],
});
const miniU = () => ({
    u_val: [0, 0, 2, 0], u_band: [-3.5, 3.5, 0, 0], u_shape: [1, 0, 0, 0],
    u_fill: a(C.line, 1), u_red: a(C.line, 1), u_glow: off, u_needle: off, u_seg: [0, 0, -0.03, 1],
});

/* shift lights: the mockup's 14 parallelograms (22 x 20, 6 apart, leaning
 * 7 px each way, an extra 12 px in the middle): one leds layer in pairs from
 * both ends, the right half leaning the other way (u_lean.z, a chevron) */
const LEAN = 14 * 22 / 20;

const layers = [
    /* the gauges sit directly on the art (they draw it, plus their light) */
    { name: 'speed', shader: 'gauge', field: 'speed', uniforms: bracketU(16) },
    { name: 'tach', shader: 'gauge', field: 'tach', uniforms: bracketU(14) },
    { name: 'fuel', shader: 'gauge', field: 'fuel', art: false, uniforms: miniU() },
    { name: 'oil', shader: 'gauge', field: 'oil', art: false, uniforms: miniU() },
    { name: 'engine', shader: 'gauge', field: 'engine', art: false, uniforms: barU(a(C.line, 1), -0.01) },
    { name: 'electric', shader: 'gauge', field: 'electric', art: false, uniforms: barU(a(C.volt, 1), 0.25) },
    /* the chevrons beside the gear, hidden but at the shift point */
    rect('chevCover', 1414, 262, 72, 82, 0, [0, 0, 0, 1]),
    { name: 'shift', shader: 'leds', x: 750, y: 43, w: 420, h: 22,
      uniforms: { u_led: [14, 0, 0, 1], u_geom: [0, 0, 22, 20], u_split: [4, 4, 0.8, 0], u_lean: [LEAN, 12, 1, 0],
                  u_c0: a(C.amber, 1), u_c1: a(C.amber, 1), u_c2: a(C.sport, 1), u_off: a(C.track, 1) } },
    { name: 'socCells', shader: 'leds', x: 798, y: 536, w: 323, h: 13,
      uniforms: { u_led: [20, 0, 0, 0], u_geom: [0, 0, 13, 9], u_split: [99, 99, 0, 0],
                  u_c0: a(C.volt, 1), u_c1: a(C.volt, 1), u_c2: a(C.volt, 1), u_off: a(C.track, 1) } },
    /* tyres: 18 x 50, 6 px corners; a 1.5 px ring black (the mockup's ground
     * stroke) or, when cold, dim over the track fill */
    rect('tyreFL', 899, 176, 18, 50, 6, a(C.dim, 1), 1.5),
    rect('tyreFR', 1003, 176, 18, 50, 6, a(C.dim, 1), 1.5),
    rect('tyreRL', 899, 330, 18, 50, 6, a(C.dim, 1), 1.5),
    rect('tyreRR', 1003, 330, 18, 50, 6, a(C.dim, 1), 1.5),
    rect('gDot', 954, 303, 12, 12, 6, a(C.line, 1)),
    text('speedText', 'big', 3, 270, 640, 350, 'right'),
    text('prefixText', 'prefix', 1, 44, 1250, 350, 'left', a(C.dim, 1)),
    text('gearText', 'big', 2, 180, 1300, 350, 'left'),
    text('kmhText', 'val', 3, 60, 584, 414, 'right'),
    text('rpmText', 'val', 4, 75, 1318, 414, 'right'),
    text('boostText', 'val', 3, 60, 1512, 414, 'right'),
    text('engineText', 'val', 3, 60, 806, 458, 'right'),
    text('electricText', 'val', 3, 60, 1126, 458, 'right'),
    text('electricLabel', 'label', 8, 130, 1120, 486, 'center', a(C.dim, 1)),
    /* both front (rear) tyres on one layer: the left value ends at 886, the
     * right one starts at 1034 (params.psiGap / tempGap, in em/en spaces) */
    text('psiFront', 'val', 11, 220, 856, 199, 'left'),
    text('psiRear', 'val', 11, 220, 856, 353, 'left'),
    text('tempFront', 'small', 13, 220, 853, 226, 'left', a(C.dim, 1)),
    text('tempRear', 'small', 13, 220, 853, 380, 'left', a(C.dim, 1)),
    text('gText', 'small', 4, 50, 964, 214, 'right'),
    text('socText', 'val', 3, 50, 1022, 525, 'right'),
    text('evRangeText', 'val', 3, 50, 1090, 525, 'right'),
    text('rangeText', 'val', 4, 60, 282, 616, 'right'),
    text('clockText', 'val', 5, 80, 390, 616, 'left'),
    text('z60Text', 'val', 4, 60, 632, 616, 'right'),
    text('coolantText', 'val', 3, 60, 1386, 616, 'right'),
    text('outsideText', 'val', 5, 80, 1540, 616, 'right'),
    text('oilText', 'val', 3, 60, 1656, 616, 'right'),
];

const src = {
    id: 'g20i1',
    title: 'G20 inspired 1',
    family: 'g20i1',
    mode: 'sport',
    version: 2,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'throttle', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm',
        'oilC', 'coolantC', 'boostBar', 'tyres', 'outsideC', 'gLat', 'gLon', 'clock'],
    params: {
        maxMph: 160, maxKrpm: 7, glow: 0.85, shiftRpm: 6000, shiftFrom: 4700, topGear: 8,
        engineMaxHp: 184, electricMaxHp: 113, regenMaxHp: 38,
        /* positions along the bracket field (0..1): the scale runs t0..1 */
        gauge: { len: R(total), t0, t1: 1 },
        bar: { len: R(barLen), zero: 0.25, gap: R(2 / barLen) },
        /* the gap between the left and right tyre values: 148 px (30 px font:
         * em 30, en 15, space 6; 24 px font: em 24, space 5) */
        psiGap: EM.repeat(4) + EN + '  ', tempGap: EM.repeat(6) + ' ',
        colors: C,
    },
    fonts: Object.keys(fonts).reduce((o, k) => { const f = Object.assign({}, fonts[k]); delete f.bl; o[k] = f; return o; }, {}),
    paths: {
        speed: { path: speedPath, inward: -1, rect: speedRect, maxd: 112 },
        tach: { mirror: 'speed' },
        fuel: { path: FUEL, inward: 1, rect: fuelRect, maxd: 6, ends: true },
        oil: { mirror: 'fuel' },
        engine: { path: ENG, inward: 1, rect: [772, 117, 38, 306], maxd: 9 },
        electric: { path: ELE, inward: 1, rect: [1110, 117, 38, 306], maxd: 9 },
    },
    layers,
};
fs.writeFileSync(path.join(__dirname, 'theme.src.json'), JSON.stringify(src, null, 1) + '\n');
console.log('speed path', R(total), 'px, scale from t', t0, ', rect', speedRect.join(' '), '; fuel rect', fuelRect.join(' '), '; bar', R(barLen), 'px');
