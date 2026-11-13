// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for tri1 ("Three-dial 1", the three-ring Sport
 * mockup) from the mockup's own geometry: the centre ring's ribbed rev band,
 * needle, bezel and shift segments (one field: the left half of the ring,
 * the right half its mirror), the side rings' bar gauges (two fields, the
 * right ring mirroring the left), the tyre cells and every readout's anchor
 * (measured off the mockup in Chrome: the start or end of each number as the
 * mockup sets it). art.html draws the static rest with the same numbers.
 *
 *   node themes/tri1/gen.js            write theme.src.json
 *   node tools/theme_build.js themes/tri1 --keep
 *
 * Reusable for the family's Comfort theme: require('../tri1/gen.js') gives
 * the geometry, the fonts and spec(), which takes overrides.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const W = 1920, BOTTOM = 646;
const D2R = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/* ---- the centre ring: the mockup draws it about (960, 322) and places it
 * with translate(960 330) scale(0.96) translate(-960 -322) ---- */
const CX = 960, CY = 330, K = 0.96;
const A0 = -135, SPAN = 270, RMAX = 8000, RED = 7000;      /* mockup angles: degrees clockwise from the top */
const ang = (rpm) => A0 + rpm / RMAX * SPAN;
/* the field's own path: an arc at R about the centre, the left half from the
 * top (t 0, 4000 rpm) down to the start of the scale (t 1, 0 rpm); the right
 * half is its mirror (t 0 at the top, t 1 at 8000 rpm). d > 0 inward. */
/* R and MAXD: Sport's reach is the needle's inner end (r 210) to the shift
 * segments (r 302); a theme with marks further out sets its own (setRing) */
let R = 256, MAXD = 47;
function setRing(r, maxd) { R = r; MAXD = maxd; }
const HALF = 135;                                            /* degrees in a half */
const tOfDeg = (a) => Math.abs(a) / HALF;                    /* mockup angle -> t in its half */
const degPx = (deg) => deg * D2R * R;                        /* degrees -> px along the field's path */
const dOf = (r) => R - r;                                    /* a radius (screen px) -> d */
const ribs = { r0: 240 * K, r1: 286 * K, lit: 2.4 * K };     /* nine ribs, 240..286 in 5.75 steps */
const bezel = { r: 296 * K, w: 3 * K, flashW: 6 * K };
const needle = { r0: 222 * K, r1: 298 * K, w: 6 * K };       /* round caps: half the width past each end */
const segs = { r: 310 * K, w: 9 * K, a0: -44, cell: 8, gap: 1.8, n: 11 };

const ribPath = () => [['A', CX, CY, R, -90, -90 - HALF]];
const ribRect = () => {
    const ro = R + MAXD + 1;
    const yEnd = CY + ro * Math.sin((-90 - HALF) * D2R);
    const x = Math.floor(CX - ro), y = Math.floor(CY - ro);
    return [x, y, CX - x, Math.ceil(yEnd) + 1 - y];
};
/* the centre ring's field (left half; the right half mirrors it) and the side rings' */
const ringPaths = () => ({
    ribs: { path: ribPath(), inward: 1, rect: ribRect(), maxd: MAXD, step: 2 },
    ribsM: { mirror: 'ribs' },
    /* one field for all four side-ring arcs: the left ring's left arc; the right
     * ring's left arc is its copy 1176 px right; the right ring's right arc its
     * mirror; the left ring's right arc a flipped copy at the mirror place
     * about x 372 */
    arcL: { path: arcLPath, inward: 1, rect: arcLRect(), maxd: RING.maxd, step: 2 },
    arcLC: { copy: 'arcL', at: [arcLRect()[0] + RING.r - RING.l, arcLRect()[1]] },
    arcLM: { mirror: 'arcL' },
    arcLF: { copy: 'arcL', flip: true, at: [2 * RING.l - arcLRect()[0] - arcLRect()[2], arcLRect()[1]] },
});

/* ---- the side rings: bezels of two 120-degree arcs at r 236, each a bar
 * gauge filling from the bottom (mockup -150 / 150) to the top ---- */
const RING = { l: 372, r: 1548, cy: 330, r0: 236, fill: 8, maxd: 5 };
const arcRect = (cx, b0, b1) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i <= 240; i++) {
        const b = (b0 + (b1 - b0) * i / 240) * D2R;
        [RING.r0 - RING.maxd - 1, RING.r0 + RING.maxd + 1].forEach((r) => {
            const x = cx + r * Math.cos(b), y = RING.cy + r * Math.sin(b);
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        });
    }
    return [Math.floor(x0), Math.floor(y0), Math.ceil(x1) - Math.floor(x0), Math.ceil(y1) - Math.floor(y0)];
};
/* the left ring's left arc (mockup -150 -> -30) and right arc (150 -> 30), as field.js angles (mockup - 90) */
const arcLPath = [['A', RING.l, RING.cy, RING.r0, -240, -120]];
const arcLRect = () => arcRect(RING.l, -240, -120);

/* ---- fonts: Barlow (the mockup's face, OFL) at the mockup's sizes, merged
 * where the 12-asset limit needs it. Digit-only fonts are cut tight about the
 * digits (0.71 em tall); fonts with letters take ascenders and descenders.
 * Barlow's baseline sits at h/2 + 0.4 size + dy in its cell. ---- */
function font(weight, size, glyphs, o) {
    o = o || {};
    const letters = /[a-z°%]/.test(glyphs);
    const h = Math.ceil(letters ? 0.95 * size + 4 : 0.71 * size + 6);
    const dy = r2(letters ? -0.135 * size : -0.045 * size);
    const cw = Math.ceil((o.wide || 0.62) * size) + 2;
    return { file: 'fonts/Barlow-' + weight + '.woff2', family: 'Barlow', weight, size: r2(size), cell: [cw, h], dy, glyphs, tracking: o.tracking };
}
let FONTS = {
    speed: font(500, 172 * K, '0123456789-', { tracking: r2(-3 * K), wide: 0.6 }),   /* 165 */
    gear: font(600, 98 * K, '0123456789NRP-', { wide: 0.7 }),                          /* 94 */
    mode: font(500, 46 * K, 'MDSPRN ', { wide: 0.9 }),                                 /* 44: the M before the gear */
    total: font(600, 76, '0123456789-'),
    big: font(600, 40, '0123456789-'),                                                 /* engine, electric */
    val: font(600, 35, '0123456789.-− '),                                              /* oil, coolant, boost, range, battery 34; psi 36 */
    mid: font(500, 32, '0123456789:-− '),                                              /* clock 32, outside 32, gear neighbours 32.6 */
    rpm: font(500, 28.8, '0123456789 -'),                                              /* rpm 28.8, average 28.8 (600) */
    small: font(500, 24, ' 0123456789.-−°%CTripmFuelEctRovng', { wide: 1.0 }),          /* odometer, trip 24; tyre temperature 25; labels 24/400 */
};
function setFonts(f) { FONTS = f; }
const base = (f) => FONTS[f].cell[1] / 2 + 0.4 * FONTS[f].size + FONTS[f].dy;

/* a text layer by its anchor: align 'left' at x (the text's start), 'right'
 * at x (its end), 'center' about x; by its baseline. cells: the most glyphs. */
function text(name, fnt, cells, align, x, baseline, color, w) {
    const f = FONTS[fnt];
    w = w || Math.ceil(f.cell[0] * cells);
    const lx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const l = { name, shader: 'text', font: fnt, x: Math.round(lx), y: Math.round(baseline - base(fnt)), w, cells, align };
    if (color) l.uniforms = { u_color: color };
    return l;
}
/* a layer the logic lays out itself (several numbers, each on its own
 * anchor): x0..x1 on screen; the anchors are kept in params.lay */
function multi(name, fnt, x0, x1, baseline, anchors, color) {
    const l = text(name, fnt, 16, 'left', x0, baseline, color, Math.ceil(x1 - x0));
    l.anchors = anchors.map((a) => ({ x: r2(a.x - l.x), align: a.align }));
    return l;
}

const hex = (h, a) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a == null ? 1 : a]
    .map((v) => Math.round(v * 1000) / 1000);
const C = {
    ink: hex('#f3f5f8'), ink2: hex('#a3abb7'), line: hex('#565e6a'), sport: hex('#ff3b2e'), elec: hex('#36d1ea'),
    elecDim: hex('#1f7888'), ok: hex('#72dd8e'), warm: hex('#ffb224'), cold: hex('#62a6ff'), none: [0, 0, 0, 0],
    /* unlit ribs: the art's lit ribs under black (white -> #252a32ish, red -> sport-dim #5c1712) */
    ribOff: [0, 0, 0, 0.88], ribOffRed: [0, 0, 0, 0.64],
};

/* ---- the layers ---- */
function layers() {
    const nb = needle;
    const ribU = (red) => ({
        u_v: [0, 0, red, 0],
        u_band: [r2(dOf(ribs.r1 + ribs.lit / 2) - 0.6), r2(dOf(ribs.r0 - ribs.lit / 2) + 0.6),
            r2(dOf(nb.r1 + nb.w / 2)), r2(dOf(nb.r0 - nb.w / 2))],
        /* the needle's half width in px along the field's path (at R): wider at its inner end */
        u_shape: [1, r2(nb.w / 2 * R / (nb.r1 + nb.w / 2)), r2(nb.w / 2 * R / (nb.r0 - nb.w / 2)), 0],
        u_fill: C.ribOff, u_red: C.ribOffRed, u_glow: C.none, u_needle: C.sport,
        u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0],
    });
    /* the shift segments, lit from the outer end (t 44/135) toward the top;
     * the band's red is the inner two ranks, so the colours swap: u_fill red
     * (t below the 4th rank), u_red white. The needle, as wide as the half,
     * is the bezel's flash. */
    const segT0 = tOfDeg(segs.a0);
    const segU = {
        u_v: [segT0, 0, r5(tOfDeg(segs.a0 + 4 * segs.cell)), 0],
        u_band: [r2(dOf(segs.r + segs.w / 2)), r2(dOf(segs.r - segs.w / 2)),
            r2(dOf(bezel.r + bezel.flashW / 2)), r2(dOf(bezel.r - bezel.flashW / 2))],
        u_shape: [1, 9999, 9999, 0],
        u_fill: C.sport, u_red: C.ink, u_glow: C.none, u_needle: [C.ink[0], C.ink[1], C.ink[2], 0],
        u_seg: [1, r2(degPx(segs.gap)), r5(segT0), r5(segT0 + segs.cell / HALF)], u_pool: [0, 0, 0, 0],
    };
    const barU = (col) => ({
        u_v: [0, 0, 2, 0], u_band: [-RING.fill / 2, RING.fill / 2, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: col, u_red: col, u_glow: C.none, u_needle: C.none, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0],
    });
    const L = [
        { name: 'ribsL', shader: 'gauge', field: 'ribs', uniforms: ribU(2) },
        { name: 'ribsR', shader: 'gauge', field: 'ribsM', uniforms: ribU(tOfDeg(ang(RED))) },
        { name: 'segsL', shader: 'gauge', field: 'ribs', art: false, uniforms: segU },
        { name: 'segsR', shader: 'gauge', field: 'ribsM', art: false, uniforms: segU },
        { name: 'eng', shader: 'gauge', field: 'arcL', uniforms: barU(C.ink) },
        { name: 'elec', shader: 'gauge', field: 'arcLF', uniforms: barU(C.elec) },
        { name: 'fuel', shader: 'gauge', field: 'arcLC', uniforms: barU(C.ink) },
        { name: 'bat', shader: 'gauge', field: 'arcLM', uniforms: barU(C.elec) },
    ];
    /* tyre cells: 26 x 56, r 7, at 1548 -+ 68 and y 232 / 350 (centres) */
    [[-1, 232], [1, 232], [-1, 350], [1, 350]].forEach((c, i) => L.push({ name: 'tyre' + i, shader: 'rect',
        x: RING.r + c[0] * 68 - 13, y: c[1] - 28, w: 26, h: 56, uniforms: { u_shape: [0, 0, 7, 2], u_color: C.ok, u_ring: C.none } }));

    /* readouts: anchors from the mockup (Chrome's start / end of each number) */
    L.push(
        text('speed', 'speed', 3, 'center', 960, 399.12),
        text('gear', 'gear', 2, 'left', 952.4, 251.28),
        text('mode', 'mode', 1, 'right', 948.56, 251.28, C.ink2),
        multi('neighbours', 'mid', 870, 1066, 249.36, [{ x: 888.96, align: 'center' }, { x: 1046.4, align: 'center' }], C.line),
        text('rpm', 'rpm', 5, 'right', 970.62, 491.28),
        text('avg', 'rpm', 3, 'right', 977, 612.24),
        text('clock', 'mid', 5, 'left', 150, 70),
        text('outside', 'mid', 3, 'right', 1740.28, 70),
        text('odo', 'small', 10, 'left', 150, 612, C.ink2),
        text('trip', 'small', 14, 'right', 1770, 612, C.ink2),
        text('total', 'total', 3, 'center', 372, 268),
        text('engV', 'big', 3, 'center', 290, 364),
        text('elV', 'big', 3, 'center', 454, 364, C.elec),
        text('elLabel', 'small', 10, 'center', 454, 390, C.ink2),
        multi('temps', 'val', 196, 498, 462, [{ x: 267.59, align: 'right' }, { x: 376.44, align: 'right' }, { x: 493.88, align: 'right' }]),
        multi('psiF', 'val', 1360, 1700, 234, [{ x: 1416.08, align: 'right' }, { x: 1644, align: 'left' }]),
        multi('psiR', 'val', 1360, 1700, 352, [{ x: 1416.08, align: 'right' }, { x: 1644, align: 'left' }]),
        text('tyreT0', 'small', 6, 'right', 1452, 263, C.ink2),
        text('tyreT1', 'small', 6, 'left', 1644, 263, C.ink2),
        text('tyreT2', 'small', 6, 'right', 1452, 381, C.ink2),
        text('tyreT3', 'small', 6, 'left', 1644, 381, C.ink2),
        text('range', 'val', 4, 'right', 1477.96, 468),
        text('fuelLabel', 'small', 10, 'center', 1466, 494, C.ink2),
        text('soc', 'val', 3, 'right', 1635.62, 468, C.elec),
    );
    return L;
}

/* the source JSON. o: { id, title, family, mode, signals, params, layers
 * (a function), fonts (a FONTS table; spec sets it) } — the Sport theme's
 * when left out. params gets len and lay (the logic-laid layers; the logic
 * takes the fonts' advances from ctx.fonts) as well. */
function spec(o) {
    o = o || {};
    if (o.fonts) setFonts(o.fonts);
    const id = o.id || 'tri1';
    const L = (o.layers || layers)();
    const lay = {};
    L.filter((l) => l.anchors).forEach((l) => {
        lay[l.name] = { font: l.font, x: l.x, w: l.w, anchors: l.anchors };
        delete l.anchors;
        delete l.align;
    });
    const fonts = {};
    Object.keys(FONTS).forEach((k) => {
        const f = FONTS[k];
        fonts[k] = { file: f.file, family: f.family, weight: f.weight, size: f.size, cell: f.cell, dy: f.dy, glyphs: f.glyphs };
        if (f.tracking) fonts[k].tracking = f.tracking;
    });
    const params = Object.assign({
        rmax: RMAX, red: RED,
        /* shift segments: six ranks from segFrom, all lit and the bezel white at the cue */
        segFrom: 5300, cue: 6400, segT0: r5(tOfDeg(segs.a0)), segStep: r5(segs.cell / HALF),
        engMaxHp: 400, elMaxHp: 120, tyreCold: 60, tyreHot: 94, colors: C,
    }, o.params || {});
    params.len = { ribs: r2(degPx(HALF)), arc: r2(RING.r0 * 120 * D2R) };
    params.lay = lay;
    return {
        id, title: o.title || 'Three-dial 1', family: 'tri1', mode: o.mode || 'sport', version: 2, bottom: BOTTOM,
        signals: o.signals || ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'oilC', 'coolantC', 'boostBar', 'fuelPct', 'rangeKm',
            'socPct', 'tyres', 'outsideC', 'odoKm', 'tripKm', 'avgKmh', 'clock'],
        params,
        fonts,
        paths: ringPaths(),
        layers: L,
    };
}

function write(s, dir) {
    const json = JSON.stringify(s, null, 1)
        .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']');
    fs.writeFileSync(path.join(dir || __dirname, 'theme.src.json'), json + '\n');
}

module.exports = { W, BOTTOM, CX, CY, K, HALF, setRing, ring: () => ({ R, MAXD }), setFonts, ang, tOfDeg, degPx, dOf, ribs, bezel, needle, segs, RING, FONTS, C, hex, font, text, multi, base, layers, spec, write, r2, r5 };

if (require.main === module) {
    const s = spec();
    write(s);
    console.log('tri1: ' + (s.layers.length + 1) + ' layers; ribs rect ' + s.paths.ribs.rect + ', arc ' + s.paths.arcL.rect);
}
