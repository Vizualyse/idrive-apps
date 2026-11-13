// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for lci1c ("LCI inspired 1 · Comfort"), the Comfort
 * theme of the lci1 family, with lci1's gen.js: the same hexagon, scales,
 * numerals and slanted bars (themes/lci1/gen.js build()), and Comfort's own
 * parts here: the pale rev band, the cruise mark on the speed scale, the
 * charge / eco / power meter, limit and cruise, the next turn, the arrival
 * line, range and fluids, the corner lines. art.html draws the static rest.
 *   node themes/lci1c/gen.js
 */
'use strict';
const lci1 = require('../lci1/gen.js');
const { hex } = lci1;

/* the field's vertical gradient (430,30 to 610: #1340d2, #0d33bd at the middle, #071b72) at y */
function fieldAt(y) {
    const stops = [[0, [0x13, 0x40, 0xd2]], [0.5, [0x0d, 0x33, 0xbd]], [1, [0x07, 0x1b, 0x72]]];
    const f = Math.max(0, Math.min(1, (y - 30) / 580));
    const i = f <= 0.5 ? 0 : 1, u = (f - stops[i][0]) / 0.5;
    return stops[i][1].map((v, k) => Math.round((v + (stops[i + 1][1][k] - v) * u) * 1000 / 255) / 1000).concat([1]);
}

const COMFORT = {
    mode: 'comfort',
    scaleX0: 226,                         /* the cruise mark sits outside the speed band */
    fonts: (F108, F100) => ({
        big: { file: F108, weight: 600, size: 112, tracking: -2.24, glyphs: '0123456789-PRNDSM ' },
        val: { file: F108, weight: 600, size: 44, glyphs: '0123456789.-−+ Of' },
        v24: { file: F108, weight: 600, size: 24, glyphs: '0123456789-:. ' },
        sub: { file: F100, weight: 500, size: 22, glyphs: ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,-−+°·%\'/' },
        label: { file: F100, weight: 600, size: 18, tracking: 1.44, glyphs: 'TURNLEFIGHmiydph -' },
        zone: { file: F100, weight: 600, size: 14, tracking: 1.4, glyphs: 'CHARGEOPW ' },
        sign: { file: F100, weight: 700, size: 34, glyphs: '0123456789- ' },
        clock: { file: F108, weight: 500, size: 32, glyphs: '0123456789:- ' },
    }),
    parts(c) {
        const { FONTS, S, COL, text, tl, T, R2, ref } = c;
        const pale = hex('#c9d8ff'), signInk = hex('#0a0d18');
        /* the rev trace at 70 %: the glow is added to the field, so 0.7 of (white - field), over the glow's 1.4 */
        const traceR = [0.47, 0.39, 0.13];
        const D = (edge) => R2(edge - ref);
        const layers = [].concat(
            c.scaleLayers('speed', 'speed', 'nums', COL.ice, COL.ice, 0.26),
            [
                /* the cruise set speed: an ice triangle 4..20 px outside the edge (the needle's taper, base 14 wide) */
                { name: 'setMark', shader: 'gauge', field: 'speed', art: false, uniforms: T({ u_band: [0, 0, D(-20), D(-4)], u_shape: [1, 7, 0, 0],
                    u_fill: COL.none, u_red: COL.none, u_needle: [COL.ice[0], COL.ice[1], COL.ice[2], 0] }) },
            ],
            c.scaleLayers('tach', 'tach', 'numsR', pale, pale, 0.2, traceR),
            [
                /* the meter: one bar from the zero tick (840), left for charge, right for eco and power */
                c.hbar('meter', 730, 172, 460, 8, 2, COL.ice),
            ],
            c.barLayers(['fuelBar', 'batBar', 'coolBar', 'mpgBar'], [COL.text, COL.ice, COL.text, COL.text]),
            [
                /* the turn arrows: the art draws both; these hide the one not taken (or both, and the stem) */
                c.mask('arrowL', 1366, 114, 39, 34, fieldAt(131)),
                c.mask('arrowR', 1412, 114, 38, 34, fieldAt(131)),
                c.mask('arrowStem', 1404, 126, 9, 39, fieldAt(145)),
                /* the art's D, hidden in P, R, N (the mode letter is then a layer) */
                c.mask('modeMask', Math.floor(S.mD.bx) - 1, 352 - 84, Math.ceil(S.mD.bw) + 2, 88, COL.box),
                /* "mpg" after the reading now, hidden on electric */
                c.mask('mpgUnitMask', Math.floor(S.mMpgUnit.bx) - 1, 490 - 15, Math.ceil(S.mMpgUnit.bw) + 2, 20, fieldAt(483)),
            ],
            [
                text('speedText', 'big', 352, 584 - 3 * FONTS.big.cell[0], 3 * FONTS.big.cell[0], COL.text, { cells: 3, align: 'right' }),
                tl('modeText', 'big', 352, Math.floor(S.mD.x0) - 2, Math.floor(S.mD.x0) + FONTS.big.cell[0] + 4),
                tl('gearDigit', 'val', 352, Math.floor(S.mGear.x0) - 2, 1540, COL.text2),
                tl('avgEv', 'val', 156, 790, 1110),
                tl('evUnit', 'label', 156, 980, 1140, COL.text2),
                tl('zones', 'zone', 208, 730, 1190),
                tl('arriveWords', 'sub', 551, 760, 1160, COL.text2),
                tl('arriveNums', 'v24', 551, 820, 1100),
                tl('limitText', 'sign', 150, 470, 542, signInk),
                tl('cruiseVal', 'val', 160, 566, 700),
                tl('cruiseUnit', 'label', 160, 566, 730, COL.text2),
                tl('manLabel', 'label', 112, 1190, 1370, COL.text2),
                tl('manDist', 'val', 160, 1210, 1370),
                tl('manUnit', 'label', 160, 1290, 1370, COL.text2),
                tl('manRoad', 'sub', 196, 1200, 1454, COL.text2),
                tl('fluids', 'v24', 490, Math.floor(S.mFuel.x0) - 20, Math.ceil(Math.max(S.mCool.x1, S.mMpg.x1)) + 2),
                tl('percents', 'sub', 518, Math.floor(S.sFuel.x0) - 2, Math.ceil(S.sBat.x0) + 80, COL.text2),
                tl('cornerTop', 'sub', 552, 64, 1856, COL.dim),
                text('clock', 'clock', 596, 64, 5 * FONTS.clock.cell[0], COL.text, { cells: 5, text: '' }),
                tl('cornerBot', 'sub', 624, 64, 1856, COL.dim),
            ]);
        return {
            layers,
            at: {
                avgEnd: S.mAvg.x1, ev: S.mEv.x0, cruise: S.mCruise.x0, dX: S.mD.x0, gear: S.mGear.x0, limitMid: 506,
                manEnd: 1368, roadEnd: 1452, zoneCharge: 783, zoneEco: 960, zonePower: 1137, arriveMid: 960,
                fuelEnd: S.mFuel.x1, batEnd: S.mBat.x1, coolEnd: S.mCool.x1, mpgEnd: S.mMpg.x1, pctFuel: S.sFuel.x0, pctBat: S.sBat.x0,
                trip: S.mTrip.x0, t0: (S.mT0.x0 + S.mT0.x1) / 2, t1: (S.mT1.x0 + S.mT1.x1) / 2, t2: (S.mT2.x0 + S.mT2.x1) / 2, t3: (S.mT3.x0 + S.mT3.x1) / 2, outside: 64, odoEnd: S.mOdo.x1,
            },
            signals: ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm', 'coolantC',
                'instL100', 'avgL100', 'evTripKm', 'limitKmh', 'cruiseKmh', 'turnDir', 'turnM', 'road', 'destKm', 'eta', 'tripKm',
                'tyres', 'outsideC', 'odoKm', 'clock'],
            params: {
                markMap: c.mapF(0),
                /* the meter, as the mockup's pwrX: charge 730..840, eco 840..1080, power 1080..1190 */
                meter: { x: 730, w: 460, zero: 840, ecoTo: 0.6, sysHp: 150, regenHp: 90, regenCell: 8 },
                coolRed: 106, mpgMax: 99,
            },
        };
    },
};

if (require.main === module) {
    lci1.build({ dir: __dirname, id: 'lci1c', title: 'LCI inspired 1 · Comfort', variant: COMFORT, fontDir: '../lci1/fonts/' });
}
module.exports = { COMFORT };
