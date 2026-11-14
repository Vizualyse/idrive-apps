// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for g20i2 ("G20 inspired 2") from the mockup's own
 * geometry: the chamfered frames (corners as quadratic curves about each
 * vertex, as the mockup's frame() draws them), the shift lamps along the
 * tach's top edge, the curved power bars, fuel and oil arcs. art.html draws
 * the same geometry with the same numbers; keep the two in step.
 *   node themes/g20i2/gen.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { flatten, measure } = require('../../tools/field.js');

const W = 1920;
const R1 = (v) => Math.round(v * 10) / 10;
const lerp = (a, b, t) => a + (b - a) * t;
const D2R = Math.PI / 180;

/* ---- the mockup's frame(): straight runs, corners as Q about the vertex ---- */
function frame(points, radii, step) {
    step = step || 2;
    const prims = [];
    let cur = points[0];
    for (let i = 1; i < points.length; i++) {
        const p = points[i];
        if (i < points.length - 1 && radii[i] > 0) {
            const a = points[i - 1], b = points[i + 1];
            const li = Math.hypot(p.x - a.x, p.y - a.y), lo = Math.hypot(b.x - p.x, b.y - p.y);
            const di = { x: (p.x - a.x) / li, y: (p.y - a.y) / li }, dout = { x: (b.x - p.x) / lo, y: (b.y - p.y) / lo };
            const c = Math.min(radii[i], li / 2, lo / 2);
            const p1 = { x: p.x - di.x * c, y: p.y - di.y * c }, p2 = { x: p.x + dout.x * c, y: p.y + dout.y * c };
            prims.push({ q: 0, a: cur, b: p1 }, { q: 1, a: p1, c: p, b: p2 });
            cur = p2;
        } else { prims.push({ q: 0, a: cur, b: p }); cur = p; }
    }
    const pts = [];
    const push = (x, y) => { const l = pts[pts.length - 1]; if (!l || Math.hypot(l.x - x, l.y - y) > 0.01) pts.push({ x, y }); };
    for (const pr of prims) {
        if (!pr.q) {
            const n = Math.max(1, Math.ceil(Math.hypot(pr.b.x - pr.a.x, pr.b.y - pr.a.y) / step));
            for (let i = 0; i <= n; i++) push(lerp(pr.a.x, pr.b.x, i / n), lerp(pr.a.y, pr.b.y, i / n));
        } else {
            for (let i = 0; i <= 40; i++) {
                const t = i / 40, u = 1 - t;
                push(u * u * pr.a.x + 2 * u * t * pr.c.x + t * t * pr.b.x, u * u * pr.a.y + 2 * u * t * pr.c.y + t * t * pr.b.y);
            }
        }
    }
    let s = 0;
    pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y); p.s = s; });
    pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1, tx = (b.x - a.x) / l, ty = (b.y - a.y) / l;
        p.nx = -ty; p.ny = tx;
    });
    return { pts, len: s, prims };
}
function mirror(f) {
    return { len: f.len, pts: f.pts.map((p) => ({ x: W - p.x, y: p.y, s: p.s, nx: -p.nx, ny: p.ny })) };
}
function at(f, s) {
    const P = f.pts; s = Math.max(0, Math.min(f.len, s));
    let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].s < s) lo = m; else hi = m; }
    const a = P[lo], b = P[hi], t = (s - a.s) / ((b.s - a.s) || 1);
    const nx = lerp(a.nx, b.nx, t), ny = lerp(a.ny, b.ny, t), nl = Math.hypot(nx, ny) || 1;
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), nx: nx / nl, ny: ny / nl };
}
const off = (f, s, d) => { const p = at(f, s); return [p.x + p.nx * d, p.y + p.ny * d]; };

const LEFT = frame([{ x: 812, y: 572 }, { x: 368, y: 572 }, { x: 198, y: 450 }, { x: 198, y: 306 }, { x: 396, y: 130 }, { x: 778, y: 84 }],
    [0, 70, 56, 56, 90, 0]);
const RIGHT = mirror(LEFT);
const S0 = 812 - 600, S1 = LEFT.len - 18;
const EXT = 100;

/* The scale's stretch of the frame (s0..s1) as M/L/Q pieces: the first run
 * starts at s0, the last run stops at s1. */
function scalePieces(mx) {
    const X = (x) => R1(mx ? W - x : x);
    const out = [];
    let s = 0;
    LEFT.prims.forEach((pr, i) => {
        const len = Math.hypot(pr.b.x - pr.a.x, pr.b.y - pr.a.y);
        if (i === 0) {
            const k = (S0 - EXT) / len;   /* starts EXT px before the scale: the pool fades past its start */
            out.push(['M', X(lerp(pr.a.x, pr.b.x, k)), R1(lerp(pr.a.y, pr.b.y, k))], ['L', X(pr.b.x), R1(pr.b.y)]);
        } else if (i === LEFT.prims.length - 1) {
            const k = 1 - 18 / len;
            out.push(['L', X(lerp(pr.a.x, pr.b.x, k)), R1(lerp(pr.a.y, pr.b.y, k))]);
        } else if (pr.q) out.push(['Q', X(pr.c.x), R1(pr.c.y), X(pr.b.x), R1(pr.b.y)]);
        else out.push(['L', X(pr.b.x), R1(pr.b.y)]);
        s += len;
    });
    return out;
}
function bbox(pieces, pad, step) {
    const pts = flatten(pieces, step || 2);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    pts.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    const pad4 = [].concat(pad);
    const [pl, pt, pr, pb] = pad4.length === 4 ? pad4 : [pad, pad, pad, pad];
    const x = Math.max(0, Math.floor(x0 - pl)), y = Math.max(0, Math.floor(y0 - pt));
    return [x, y, Math.ceil(x1 + pr) - x, Math.ceil(y1 + pb) - y];
}
const lengthOf = (pieces) => { const c = measure(flatten(pieces)); return c[c.length - 1]; };


/* ---- speed: the frame's scale run, inward toward the dial; the tach is its mirror image ---- */
const GLOW = 125;                 /* how far in the wake reaches (the mockup's widest band ends at 104, then a 9 px blur) */
const OUT = 48;                   /* outward: a quarter of the glow and the edge of the pool */
const speedPath = scalePieces(false);
const speedRect = bbox(speedPath, 3 + OUT);
const SPEED_T0 = +(EXT / lengthOf(speedPath)).toFixed(5);   /* where the scale starts along the path */

/* ---- shift lamps: 10 along the tach's top edge, centred 19 px outside the frame,
 * equal lengths along that line with 6 px gaps (u_seg); then the upshift chevron ---- */
const TACH_MAP = [[0, 0], [1, .17], [2, .31], [3, .44], [4, .57], [5, .71], [6, .855], [7, 1]];
const SPEED_MAP = [[0, 0], [20, .17], [40, .3], [60, .42], [80, .54], [100, .66], [120, .78], [160, 1]];
function stops(map, v) {
    for (let i = 1; i < map.length; i++) if (v <= map[i][0]) {
        const [v0, f0] = map[i - 1], [v1, f1] = map[i];
        return lerp(f0, f1, (v - v0) / (v1 - v0));
    }
    return map[map.length - 1][1];
}
const sTach = (krpm) => lerp(S0, S1, stops(TACH_MAP, krpm));
const LAMP_FROM = 4.6, LAMP_TO = 6.25, LAMPS = 10, LAMP_D = -19;
const sa = sTach(LAMP_FROM), sb = sTach(LAMP_TO);
const lampPath = [];
for (let s = sa; ; s += 3) {
    const q = off(RIGHT, Math.min(s, sb), LAMP_D).map(R1);
    lampPath.push([lampPath.length ? 'L' : 'M', q[0], q[1]]);
    if (s >= sb) break;
}
const lampEnd = lampPath.length;
const ext = off(RIGHT, sb + 10, LAMP_D).map(R1);
lampPath.push(['L', ext[0], ext[1]]);
/* away to the chevron, arriving along its left stroke */
const CHEV = [[1426, 214], [1450, 196], [1474, 214]];
lampPath.push(['L', 1402, 232]);
CHEV.forEach((p) => lampPath.push(['L', p[0], p[1]]));
const lampLen = lengthOf(lampPath);
const lampT1 = +(lengthOf(lampPath.slice(0, lampEnd)) / lampLen).toFixed(5);       /* where the lamps end */
const chevT = +(lengthOf(lampPath.slice(0, lampEnd + 3)) / lampLen).toFixed(5);    /* the chevron's left end */
const lampRect = bbox(lampPath, 12);

/* ---- power bars: engine (R 532) and electric (R 610), 22 wide, about (682, 380), +13..-13 deg ---- */
const BCX = 682, BCY = 380, ENG_R = 532 - 11, ELE_R = 610 - 11;
const barPath = [['A', BCX, BCY, ENG_R, 13, -16],
    ['L', R1(BCX + ELE_R * Math.cos(-16 * D2R)), R1(BCY + ELE_R * Math.sin(-16 * D2R))],
    ['A', BCX, BCY, ELE_R, -16, 13]];
const barLen = lengthOf(barPath);
const engArc = lengthOf([barPath[0]]), engFull = engArc * 26 / 29;
const eleStart = lengthOf(barPath.slice(0, 2)), eleArc = barLen - eleStart;
const barT = {
    eng0: 0, eng1: +(engFull / barLen).toFixed(5),
    /* electric runs top to bottom: f (0 bottom .. 1 top) -> t */
    eleTop: +((eleStart + eleArc * 3 / 29) / barLen).toFixed(5), eleBottom: 1,
};
const ENG_MAX = 400, ELE_MIN = -80, ELE_MAX = 120;
const eleZero = +lerp(barT.eleBottom, barT.eleTop, -ELE_MIN / (ELE_MAX - ELE_MIN)).toFixed(5);
const barRect = bbox(barPath, 13);

/* ---- fuel: the arc about (332, 432) R 222, empty at 161 deg (bottom), full at 199 ---- */
const fuelPath = [['A', 332, 432, 222, 161, 199]];
const fuelRect = bbox(fuelPath, 6);

/* ---- fonts: Barlow Semi Condensed; ascent 1.0 em, descent 0.2 em; a glyph's
 * baseline sits at h/2 + 0.4 size + dy in its cell; the cell is at least the widest advance ---- */
const FONTS = {
    speed: { size: 156, cell: [80, 124], dy: -6, glyphs: '0123456789 -' },
    gear: { size: 200, cell: [120, 160], dy: -8, glyphs: '0123456789NRPD- ' },
    mode: { size: 44, cell: [30, 48], dy: 0, glyphs: 'MDSNRP -' },
    psi: { size: 30, cell: [16, 34], dy: 0, glyphs: '0123456789 -' },
    mid: { size: 26, cell: [22, 30], dy: 0, glyphs: '0123456789 -−+.:%°Cmi' },
    small: { size: 19, cell: [16, 24], dy: 0, glyphs: '0123456789 -°Cmi' },
    cap: { size: 16, cell: [16, 20], dy: 0, weight: 600, tracking: 1.92, glyphs: 'COLDTYRES0123456789 Emi-' },
};
const base = (f) => FONTS[f].cell[1] / 2 + 0.4 * FONTS[f].size + FONTS[f].dy;
/* a text layer from its baseline and its right end (align right), left start (left) or centre; w px wide */
function text(name, font, cells, align, bx, by, w, color) {
    const f = FONTS[font];
    const x = align === 'right' ? bx - w : align === 'center' ? bx - w / 2 : bx;
    const l = { name, shader: 'text', font, x: Math.round(x), y: Math.round(by - base(font)), w: Math.round(w), cells, align };
    if (color) l.uniforms = { u_color: color };
    return l;
}
const hex = (h, a) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a == null ? 1 : a]
    .map((v) => Math.round(v * 1000) / 1000);
const C = {
    ink: hex('#f1f0ec'), ink2: hex('#b4b2ac'), ink3: hex('#8a8882'), ink4: hex('#3a3936'), sport: hex('#ff3a1c'),
    needle: hex('#ff8a2a'), amber: hex('#ffb21a'), orange: hex('#ff6a10'), red: hex('#ff2414'), edrive: hex('#3aa2ff'),
    regen: hex('#9fd2ff'), chevDim: hex('#5a1a10'), none: [0, 0, 0, 0],
};

/* the wake: added to the art (ticks and numerals brighten under it), a pool of light at the pointer */
const TRAIL = 360;
const gaugeU = (trail) => ({
    u_val: [0, 0, 2, trail], u_band: [0, 0, 2, 46], u_shape: [GLOW, 4.5, 2, 0.06],
    u_fill: C.none, u_red: C.none, u_glow: [1, 0.3, 0.07, 1.2], u_needle: C.needle,
    u_pool: [90, 0.6, 40, 0], u_seg: [0, 0, SPEED_T0, 1],
    /* a flatter falloff than squared reaches further in (the mockup's broad wake); the art brightens under it */
    u_look: [0.38, 0.35, 1.4, 0],
});
const bandU = (b, fill, red, z, seg, glow) => ({
    u_val: [0, 0, z, 1], u_band: [-b, b, 0, 0], u_shape: [glow ? glow[0] : 1, 0, 0, 1],
    u_fill: fill, u_red: red, u_glow: glow ? glow[1] : C.none, u_needle: C.none, u_seg: seg || [0, 0, 0, 1],
});
const LSEG = [LAMPS, 6, 0, lampT1];
const layers = [
    { name: 'speed', shader: 'gauge', field: 'speed', uniforms: gaugeU(+(TRAIL / lengthOf(speedPath)).toFixed(4)) },
    { name: 'tach', shader: 'gauge', field: 'tach', uniforms: gaugeU(+(TRAIL / lengthOf(speedPath)).toFixed(4)) },
    /* lamps: A amber, orange past lamp 4; B red past lamp 7 (over A); the chevron. Blended, not on the art:
     * they overlap the tach's rectangle */
    { name: 'lampsA', shader: 'gauge', field: 'lamps', art: false,
      uniforms: bandU(6.5, C.amber, C.orange, +(lampT1 * 4 / LAMPS).toFixed(5), LSEG, [9, [1, 0.33, 0.08, 0.6]]) },
    { name: 'lampsB', shader: 'gauge', field: 'lamps', art: false,
      uniforms: bandU(6.5, C.none, C.red, +(lampT1 * 7 / LAMPS).toFixed(5), LSEG) },
    { name: 'chevron', shader: 'gauge', field: 'lamps', art: false,
      uniforms: Object.assign(bandU(2.5, C.red, C.red, 2, [0, 0, chevT, 1]), { u_val: [1, 0, 2, 1] }) },
    { name: 'eng', shader: 'gauge', field: 'bars', art: false, uniforms: bandU(11, C.sport, C.sport, 2, [0, 0, barT.eng0, 1]) },
    { name: 'ele', shader: 'gauge', field: 'bars', art: false, uniforms: bandU(11, C.edrive, C.edrive, 2, [0, 0, eleZero, 1]) },
    { name: 'fuel', shader: 'gauge', field: 'fuel', art: false, uniforms: bandU(3.5, C.ink, C.ink, 2) },
    /* HV battery: 20 segments 7.5 x 16 on an 11 px pitch from x 484 */
    { name: 'soc', shader: 'leds', x: 482, y: 447, w: 220, h: 16, uniforms: {
        u_led: [20, 0, 0, 0], u_geom: [0, 0, 7.5, 16], u_split: [99, 99, 0, 1],
        u_c0: C.edrive, u_c1: C.edrive, u_c2: C.edrive, u_off: C.ink4 } },
    { name: 'oilMark', shader: 'rect', x: 1800, y: 430, w: 20, h: 7, uniforms: { u_shape: [0, 0, 0, 0], u_color: C.ink } },
];
[[892, 240], [1012, 240], [892, 386], [1012, 386]].forEach((p, i) => layers.push({ name: 'tyreHot' + i, shader: 'rect',
    x: p[0], y: p[1], w: 16, h: 46, uniforms: { u_shape: [0, 0, 4, 0], u_color: C.sport } }));
layers.push(
    text('kmh', 'speed', 3, 'right', 620, 392, 240),
    text('gear', 'gear', 1, 'center', 1450, 392, 120),
    text('mode', 'mode', 1, 'right', 1372, 300, 30, C.ink2),
    text('rpm', 'mid', 6, 'right', 1520, 462, 80),
    text('engHp', 'mid', 4, 'center', 1195.6, 248.8, 60),
    text('eleHp', 'mid', 4, 'center', 1271.6, 231.3, 60),
    text('socPct', 'mid', 5, 'left', 712, 463, 64),
    text('evRange', 'cap', 8, 'left', 712, 490, 80, C.ink2),
    /* tyres, either side of the car plan: psi over deg C */
    text('psiFL', 'psi', 3, 'right', 876, 264, 48),
    text('psiFR', 'psi', 3, 'left', 1044, 264, 48),
    text('psiRL', 'psi', 3, 'right', 876, 410, 48),
    text('psiRR', 'psi', 3, 'left', 1044, 410, 48),
    text('tempFL', 'small', 6, 'right', 876, 292, 64, C.ink2),
    text('tempFR', 'small', 6, 'left', 1044, 292, 64, C.ink2),
    text('tempRL', 'small', 6, 'right', 876, 438, 64, C.ink2),
    text('tempRR', 'small', 6, 'left', 1044, 438, 64, C.ink2),
    text('coldNote', 'cap', 10, 'center', 960, 498, 160, C.ink3),
    text('oilC', 'small', 6, 'center', 1816, 598, 70, C.ink2),
    /* status row */
    text('range', 'mid', 7, 'left', 238, 624, 100),
    text('clock', 'mid', 5, 'center', 520, 624, 80),
    text('odo', 'small', 9, 'center', 960, 624, 120, C.ink2),
    text('outside', 'mid', 8, 'right', 1684, 624, 110),
);
/* the odometer is 21 px in the mockup: the small font (19) is the closest */

const spec = {
    id: 'g20i2', title: 'G20 inspired 2', version: 2, bottom: 646,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm', 'oilC', 'tyres',
        'outsideC', 'odoKm', 'clock'],
    params: {
        speedT0: SPEED_T0, scaleLen: +lengthOf(speedPath).toFixed(2), speedMap: SPEED_MAP, tachMap: TACH_MAP, lampFrom: LAMP_FROM * 1000, lampTo: LAMP_TO * 1000, shiftCue: LAMP_TO * 1000,
        lamps: LAMPS, lampT1, barT, eleZero, engMaxHp: ENG_MAX, eleMinHp: ELE_MIN, eleMaxHp: ELE_MAX, tyreHotC: 95, tyreColdC: 40,
        oil: { cx: W - 332, cy: 432, r: 223, a0: 19, a1: -19, from: 50, to: 150 },
        colors: C,
    },
    fonts: {},
    paths: {
        speed: { path: speedPath, inward: -1, rect: speedRect, maxd: 127 },
        tach: { mirror: 'speed' },
        lamps: { path: lampPath, inward: -1, rect: lampRect, maxd: 10 },
        bars: { path: barPath, inward: 1, rect: barRect, maxd: 12 },
        fuel: { path: fuelPath, inward: 1, rect: fuelRect, maxd: 5 },
    },
    layers,
};
Object.keys(FONTS).forEach((k) => {
    const f = FONTS[k], wt = f.weight || 500;
    spec.fonts[k] = { file: '../fonts/BarlowSemiCondensed-' + wt + '.woff2', weight: wt, size: f.size, cell: f.cell, dy: f.dy, glyphs: f.glyphs };
    if (f.tracking) spec.fonts[k].tracking = f.tracking;
});

/* compact JSON: one line per path piece list and per layer */
function writeSpec(dir, s) {
    const json = JSON.stringify(s, null, 1)
        .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']');
    fs.writeFileSync(path.join(dir, 'theme.src.json'), json + '\n');
}
if (require.main === module) {
    writeSpec(__dirname, spec);
    console.log('layers', layers.length + 1, 'speed rect', speedRect, 'lamps', lampRect, 'bars', barRect, 'fuel', fuelRect,
        'lampT1', lampT1, 'chevT', chevT, 'barT', JSON.stringify(barT), 'eleZero', eleZero);
}

/* the Comfort theme of the family (themes/g20i2c/gen.js) builds on the same geometry */
module.exports = { W, R1, lerp, D2R, LEFT, RIGHT, S0, S1, EXT, off, at, scalePieces, bbox, lengthOf, stops, hex,
    SPEED_MAP, TACH_MAP, speedPath, speedRect, SPEED_T0, barPath, barT, barRect, fuelPath, fuelRect, FONTS, base, text, writeSpec };
