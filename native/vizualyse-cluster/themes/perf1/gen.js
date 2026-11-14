// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for perf1 ("Performance 1", Sport) from the mockup's
 * own geometry (perf-fable index.html, DESIGN.md): two open-bottomed round
 * dials (speed at x 330, revs at x 1590, y 318), the shift lights, the power
 * balance bar, the readings and the tyres. art.html draws the static parts
 * with the same numbers; keep the two in step.
 *   python themes/perf1/fonts/fonts.py   (once: the Archivo instances and metrics)
 *   node themes/perf1/gen.js
 */
'use strict';
const G = require('./gen_lib.js');
const { C, hex, font, fontSpec, text, textRow, dialPath, leds, barLeds, rect } = G;

const SX = 330, TX = 1590, CY = 318;
const SHIFT = 6400;                      /* the shift point (art.html SHIFT); the bench drive shifts at 6600 */

/* ---- fonts: Archivo 600 at 108% for readings, 500 at 100% for units and the state word ---- */
const F = {
    big: font('600-108', 116, '0123456789- '),
    gear: font('600-108', 128, '0123456789NRPD- '),
    pre: font('600-108', 46, 'MDS '),
    sys: font('600-108', 80, '0123456789−- '),
    p40: font('600-108', 40, '0123456789+−- '),
    r36: font('600-108', 36, '0123456789.- '),
    r29: font('600-108', 29, '0123456789,.- '),
    s22: font('600-108', 22, '0123456789:.−- °C'),
    u19: font('500-100', 19, ' hpLmi°CbarV%ASITNGHROD'),
};

/* ---- the dials: one field, the rev counter's a copy of the speedometer's moved 1260 px (no upload) ---- */
const R_PATH = 258;                      /* the swept band's outer edge: the glow runs inward from here */
const dS = dialPath(SX, CY, R_PATH, 2, 32, 190), dT = dialPath(TX, CY, R_PATH, 2, 32, 190);
const dialU = (d) => ({
    /* trail: the brighter last 40 degrees of the swept band */
    u_val: [d.t0, 0, 2, +(40 / 244).toFixed(4)],
    /* value arc r 268..276 (d -18..-10); needle r 232..284 (d 26..-26) */
    u_band: [-18, -10, -26, 26],
    /* glow 100 px deep, linear, from the path inward (cut at the numerals' inner edge); 35% of it along the swept part */
    u_shape: [100, 3.5, 3.5, 0.35],
    u_fill: C.sport, u_red: C.sport,
    u_glow: G.scaleRGB(C.sport, 0.42).slice(0, 3).concat([1]),
    u_needle: hex('#ff9a8a'),
    u_seg: [0, 0, +d.t0.toFixed(5), 1],
    /* the needle's red glow: a pool around it */
    u_pool: [18, 1.8, 0, 0],
    /* no outward glow; the art under the glow brightened: tick-grey numerals turn white once passed */
    u_look: [0, 10, 1, 0],
});

const layers = [
    { name: 'speedDial', shader: 'gauge', field: 'speedDial', uniforms: dialU(dS) },
    { name: 'tachDial', shader: 'gauge', field: 'tachDial', uniforms: dialU(dT) },

    /* top row: twelve shift lights (8 amber, 4 red; all red flashing at the shift point), time, outside */
    leds('lights', 744, 35, 432, 20, { u_led: [12, 0, 0, 0], u_geom: [0, 0, 30, 20], u_split: [8, 8, 2, 0],
        u_c0: C.amber, u_c1: C.amber, u_c2: C.sport, u_off: C.track }),
    text('clock', F.s22, 's22', 5, 'end', 640, 53, C.ink),
    text('outside', F.s22, 's22', 6, 'end', 722, 53, C.ink2),

    /* the rev counter's centre: floods red at the shift point; the upshift chevron; M, gear, rpm */
    rect('flood', TX - 158, CY - 158, 316, 316, 158, C.deep, { uniforms: { u_shape: [0, 0, 158, 1.5], u_color: C.deep, u_ring: C.line } }),
    /* chevron: (TX-34, CY-88) - (TX, CY-118) - (TX+34, CY-88), 9 wide: two sheared lights, the right half leaning back */
    leds('chevron', 1545, 196, 91, 38, { u_led: [2, 0, 0, 0], u_geom: [0, 0, 13.6, 38], u_split: [99, 99, 2, 1],
        u_lean: [43, 20.4, 1, 0], u_c0: C.amber, u_c1: C.amber, u_c2: C.amber, u_off: C.none }),
    text('gearMode', F.pre, 'pre', 1, 'end', TX - 30, CY + 34, C.ink2),
    text('gear', F.gear, 'gear', 1, 'middle', TX + 18, CY + 34, C.ink),
    text('rpm', F.r29, 'r29', 5, 'end', TX + 22, CY + 88, C.ink),
    text('rpmUnit', F.u19, 'u19', 3, 'start', TX + 30, CY + 88, C.ink2, { text: 'rpm' }),

    /* the speedometer's centre */
    text('speed', F.big, 'big', 3, 'middle', SX, CY + 34, C.ink),

    /* power balance: figures, then the bar (engine right of zero, electric stacked on it, regen left of zero) */
    text('sys', F.sys, 'sys', 4, 'middle', 948, 190, C.ink),
    textRow('pw', F.p40, 'p40', 648, 1240, 174, C.ink),
    textRow('pwUnit', F.u19, 'u19', 648, 820, 174, C.ink2),
    barLeds('engBar', 774, 214, 498, 22, C.sport),
    barLeds('elBar', 774, 214, 160, 22, C.elec),

    /* boost and battery row (numbers at y 362), boost bar and peak, HV segments and state */
    textRow('n362', F.r36, 'r36', 648, 1200, 362, C.ink),
    textRow('u362', F.u19, 'u19', 648, 1230, 362, C.ink2),
    barLeds('boostBar', 648, 376, 160, 8, C.sport),
    rect('peakMark', 647, 372, 3, 16, 0, C.ink),
    text('peak', F.s22, 's22', 4, 'end', 808, 440, C.ink),
    leds('hv', 1111, 376, 162, 8, { u_led: [10, 0, 0, 0], u_geom: [0, 0, 14.2, 8], u_split: [99, 99, 1, 0],
        u_c0: C.elec, u_c1: C.elec, u_c2: C.elec, u_off: C.none }),
    textRow('hvState', F.u19, 'u19', 1112, 1300, 440, C.ink3),

    /* the row at y 544: 12 V, rear tyre pressures, electric range */
    textRow('n544', F.r29, 'r29', 648, 1200, 544, C.ink),
    textRow('u544', F.u19, 'u19', 648, 1230, 544, C.ink2),

    /* tyres: front pressures and temperatures, rear temperatures, the blocks (cold grey to warm white) */
    textRow('psiF', F.r29, 'r29', 840, 1080, 362, C.ink),
    textRow('tempF', F.s22, 's22', 840, 1080, 388, C.ink2),
    textRow('tempR', F.s22, 's22', 840, 1080, 570, C.ink2),
    leds('tyresF', 904, 340, 112, 50, { u_led: [2, 2, 0, 0], u_geom: [0, 0, 14, 50], u_split: [1, 2, 4, 0], u_lean: [0, 84, 0, 0],
        u_c0: C.ink2, u_c1: C.ink2, u_c2: C.ink2, u_off: C.none }),
    leds('tyresR', 904, 508, 112, 50, { u_led: [2, 2, 0, 0], u_geom: [0, 0, 14, 50], u_split: [1, 2, 4, 0], u_lean: [0, 84, 0, 0],
        u_c0: C.ink2, u_c1: C.ink2, u_c2: C.ink2, u_off: C.none }),

    /* under the dials: fuel, range | oil, coolant (numbers at y 542) and their bars */
    textRow('n542L', F.r36, 'r36', 170, 450, 542, C.ink),
    textRow('n542R', F.r36, 'r36', 1430, 1700, 542, C.ink),
    textRow('u542', F.u19, 'u19', 170, 1760, 542, C.ink2),
    barLeds('fuelBar', 170, 556, 150, 8, C.ink),
    barLeds('oilBar', 1430, 556, 150, 8, C.ink),
    barLeds('coolBar', 1610, 556, 150, 8, C.ink),
];

const lay = {};
layers.filter((l) => l.shader === 'text').forEach((l) => { lay[l.name] = { font: l.font, x: l.x, w: l.w || F[l.font].cw * l.cells }; });

const spec = {
    id: 'perf1', title: 'Performance 1', family: 'perf1', mode: 'sport', version: 2, bottom: 646,
    signals: ['kmh', 'rpm', 'gear', 'gearMode', 'engineHp', 'elecHp', 'socPct', 'evRangeKm', 'fuelPct', 'rangeKm',
        'oilC', 'coolantC', 'boostBar', 'tyres', 'outsideC', 'clock', 'volts12'],
    params: {
        shiftRpm: SHIFT, lightsFrom: 4600, preRpm: SHIFT - 550, speedMax: 180, tachMax: 8000,
        dial: { t0: +dS.t0.toFixed(5), t1: +dS.t1.toFixed(5) },
        /* the power bar: -100..400 hp over x 648..1272 */
        power: { zeroX: 772.8, pxPerHp: 1.248, x1: 1272, engX: 774 },
        boostMax: 1.5, tankL: 59, oil: [70, 150], cool: [50, 130], tyreCold: 20, tyreWarm: 90,
        colors: { ink: C.ink, ink2: C.ink2, ink3: C.ink3, tick: C.tick, sport: C.sport, deep: C.deep, amber: C.amber, elec: C.elec,
            track: C.track, none: C.none, cool: hex('#5c6473'), warm: hex('#f3f5f8') },
        fonts: G.fontParams(F), lay,
    },
    fonts: {},
    paths: { speedDial: dS.spec, tachDial: { copy: 'speedDial', at: [dS.spec.rect[0] + TX - SX, dS.spec.rect[1]] } },
    layers,
};
Object.keys(F).forEach((k) => { spec.fonts[k] = fontSpec(F[k]); });
G.write(__dirname, spec);
console.log('layers', layers.length + 1, 'dial rect', dS.spec.rect, 'len', dS.len.toFixed(1), 't0', dS.t0.toFixed(4),
    'fonts', Object.keys(F).map((k) => k + ' ' + F[k].cw + 'x' + F[k].ch).join(', '));
