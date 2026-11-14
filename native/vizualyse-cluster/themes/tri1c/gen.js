// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for tri1c ("Three-dial 1 · Comfort"), the Comfort
 * theme of the tri1 family, from the Comfort mockup's geometry with tri1's
 * generator (../tri1/gen.js): the same rings and fields, the centre dial a
 * 0-160 mph speedometer with the limit arc and the cruise set mark outside
 * its bezel; economy on the left ring, route and range on the right.
 *   node themes/tri1c/gen.js && node tools/theme_build.js themes/tri1c --keep
 */
'use strict';
const G = require('../tri1/gen.js');
const { K, C, hex, font, text, multi, dOf, degPx, r2 } = G;

/* the field reaches from the needle's inner end (r 210) out to the cruise
 * mark's base (r 318) */
G.setRing(264, 55);

const VMAX = 160;
const ang = (mph) => -135 + Math.max(0, Math.min(VMAX, mph)) / VMAX * 270;
const ribs = { r0: 240 * K, r1: 286 * K, lit: 1.8 * K };
const needle = { r0: 222 * K, r1: 298 * K, w: 6 * K };
const limitArc = { r: 305 * K, w: 5 * K, deg: 3.5 };
const setMark = { tip: 314 * K, base: 330 * K, half: 9 * K, stroke: 2.5 * K };

const F = (w, size, glyphs, o) => { const f = font(w, size, glyphs, o); f.file = '../tri1/' + f.file; return f; };
const FONTS = {
    speed: F(500, 172 * K, '0123456789-', { tracking: r2(-3 * K), wide: 0.6 }),
    mode: F(600, 84 * K, 'DMSPRN- ', { wide: 0.8 }),                                     /* the D, 81 */
    gear: F(500, 38 * K, '0123456789NRP-', { wide: 0.7 }),                               /* the gear beside it, 36.5 */
    total: F(600, 76, '0123456789.-'),                                                   /* average mpg */
    big: F(600, 40, '0123456789-–+ '),                                                   /* mpg now, electric %, set speed 38.4 */
    val: F(600, 34, '0123456789.-'),
    clock: F(500, 32, '0123456789:-− '),                                                /* clock, outside */
    mid: F(600, 29.5, '0123456789-– Elctri'),                                           /* limit 30.7/600, range 28.8/600, rpm / Electric 28.8/500 */
    /* labels, the road name (any letters), tyres and arrival lines: 24 */
    small: F(500, 24, "j 0123456789.,-−·/:%&'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghiklmnopqrstuvwxyz", { wide: 0.95 }),
};

const CC = Object.assign({}, C, { limit: C.sport, charge: C.ok, ribOff: [0, 0, 0, 0.77] });

function layers() {
    const R = G.ring().R;
    const nb = needle;
    const ribU = {
        u_val: [0, 0, 2, 0],
        u_band: [r2(dOf(ribs.r1 + ribs.lit / 2) - 0.6), r2(dOf(ribs.r0 - ribs.lit / 2) + 0.6),
            r2(dOf(nb.r1 + nb.w / 2)), r2(dOf(nb.r0 - nb.w / 2))],
        u_shape: [1, r2(nb.w / 2 * R / (nb.r1 + nb.w / 2)), r2(nb.w / 2 * R / (nb.r0 - nb.w / 2)), 0],
        u_fill: CC.ribOff, u_red: CC.ribOff, u_glow: C.none, u_needle: C.ink, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0],
    };
    /* the limit arc: a needle 7 degrees wide (its half width the same angle at either end) */
    const hw = r2(degPx(limitArc.deg));
    const limU = {
        u_val: [0, 0, 2, 0], u_band: [0, 0, r2(dOf(limitArc.r + limitArc.w / 2)), r2(dOf(limitArc.r - limitArc.w / 2))],
        u_shape: [1, hw, hw, 0], u_fill: C.none, u_red: C.none, u_glow: C.none, u_needle: CC.limit, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0],
    };
    /* the cruise set mark: a needle tapering from the base (outside) to the tip (inside), filled */
    const so = setMark.base + setMark.stroke / 2, si = setMark.tip - setMark.stroke / 2;
    const setU = {
        u_val: [0, 0, 2, 0], u_band: [0, 0, r2(dOf(so)), r2(dOf(si))],
        u_shape: [1, r2((setMark.half + setMark.stroke / 2) * R / so), r2(setMark.stroke / 2 * R / si), 0],
        u_fill: C.none, u_red: C.none, u_glow: C.none, u_needle: C.ink, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0],
    };
    const barU = (col) => ({
        u_val: [0, 0, 2, 0], u_band: [-4, 4, 0, 0], u_shape: [1, 0, 0, 0],
        u_fill: col, u_red: col, u_glow: C.none, u_needle: C.none, u_seg: [0, 0, 0, 1], u_pool: [0, 0, 0, 0],
    });
    return [
        { name: 'ribsL', shader: 'gauge', field: 'ribs', uniforms: ribU },
        { name: 'ribsR', shader: 'gauge', field: 'ribsM', uniforms: ribU },
        { name: 'limitL', shader: 'gauge', field: 'ribs', art: false, uniforms: limU },
        { name: 'limitR', shader: 'gauge', field: 'ribsM', art: false, uniforms: limU },
        { name: 'setL', shader: 'gauge', field: 'ribs', art: false, uniforms: setU },
        { name: 'setR', shader: 'gauge', field: 'ribsM', art: false, uniforms: setU },
        { name: 'eng', shader: 'gauge', field: 'arcL', uniforms: barU(C.ink) },
        { name: 'elec', shader: 'gauge', field: 'arcLF', uniforms: barU(C.elec) },
        { name: 'fuel', shader: 'gauge', field: 'arcLC', uniforms: barU(C.ink) },
        { name: 'bat', shader: 'gauge', field: 'arcLM', uniforms: barU(C.elec) },
        /* the turn arrow: the art draws it both ways about its stem (x 1511); this covers the way not taken */
        { name: 'turnCover', shader: 'rect', x: 1478, y: 340, w: 66, h: 48, uniforms: { u_shape: [0, 0, 0, 0], u_color: [0, 0, 0, 1], u_ring: C.none } },

        text('speed', 'speed', 3, 'center', 960, 399.12),
        text('mode', 'mode', 1, 'right', 972.32, 257.04),
        text('gear', 'gear', 2, 'left', 978.08, 257.04, C.ink2),
        text('limit', 'mid', 3, 'center', 869.76, 244.56),
        text('set', 'big', 3, 'center', 1050.24, 241.68),
        multi('rpm', 'mid', 880, 1040, 491.28, [{ x: 970.62, align: 'right' }, { x: 960, align: 'center' }], C.ink2),
        text('rpmUnit', 'small', 3, 'left', 976.38, 491.28, C.ink2),
        text('range', 'mid', 4, 'right', 1003.19, 612.24),
        text('clock', 'clock', 5, 'left', 150, 70),
        text('outside', 'clock', 3, 'right', 1740.28, 70),
        multi('tyres', 'small', 150, 400, 612, [{ x: 150, align: 'left' }, { x: 210, align: 'left' }], C.ink2),
        multi('arrive', 'small', 1440, 1765, 612, [{ x: 1700, align: 'right' }], C.ink2),
        text('togo', 'small', 8, 'right', 1770, 612, C.ink2),
        text('avg', 'total', 4, 'center', 372, 268),
        text('now', 'big', 3, 'right', 286.05, 364),
        text('elV', 'big', 3, 'right', 452.09, 364, C.elec),
        text('elLabel', 'small', 8, 'center', 454, 390, C.ink2),
        multi('row', 'val', 190, 512, 462, [{ x: 258.44, align: 'right' }, { x: 378.12, align: 'right' }, { x: 507.1, align: 'right' }]),
        text('dist', 'val', 4, 'left', 1528, 380),
        multi('distUnit', 'small', 1556, 1700, 380, [{ x: 1587.89, align: 'left' }], C.ink2),
        text('road', 'small', 16, 'center', 1548, 408, C.ink2),
        text('fuelRange', 'val', 4, 'right', 1477.96, 468),
        text('fuelLabel', 'small', 10, 'center', 1466, 494, C.ink2),
        text('batRange', 'val', 3, 'right', 1632.81, 468, C.elec),
        text('batLabel', 'small', 12, 'center', 1630, 494, C.ink2),
    ];
}

const s = G.spec({
    id: 'tri1c', title: 'Three-dial 1 · Comfort', mode: 'comfort', fonts: FONTS, layers,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'coolantC', 'fuelPct', 'rangeKm', 'socPct', 'evRangeKm',
        'tyres', 'outsideC', 'clock', 'tripKm', 'avgL100', 'avgKmh', 'limitKmh', 'cruiseKmh', 'instL100', 'turnDir', 'turnM',
        'road', 'destKm', 'eta'],
    params: {
        vmax: VMAX, limitDeg: limitArc.deg, setDeg: 2, engMaxHp: 400, elMaxHp: 120, colors: CC,
        turnCover: { left: 1512.8, right: 1443.2, none: 1478 }, turnShift: 30, distX: 1528,
    },
});
G.write(s, __dirname);
void hex;
console.log('tri1c: ' + (s.layers.length + 1) + ' layers; ribs rect ' + s.paths.ribs.rect);
