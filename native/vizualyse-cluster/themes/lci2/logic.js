// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// LCI inspired 2 (Sport): speed and revs climb the two flank bands round the
// lens (an ice-blue fill and a warm-to-red one, white needles, the numerals
// lighting as the needle passes), twelve shift lights filling from both ends
// inward, then the row, the lens outline and the chevron flashing red at the
// cue. Power split, tyre map, fuel, oil, readouts. UK units: mph, miles,
// psi, deg C. A reading the source does not give shows "--".
'use strict';
const MPH = 0.621371, PSI = 14.5038;

const ok = (v) => v != null && isFinite(v);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const fix = (v, n) => (ok(v) ? v.toFixed(n) : '--');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const MINUS = '−', EM = ' ', EN = ' ';

/* the mid font's advances in whole pixels, as the build lays them out */
const MID = { d: 17, '.': 7, ' ': 6, '-': 10, [EN]: 15, [EM]: 30 };
const midW = (s) => s.split('').reduce((n, c) => n + (/\d/.test(c) ? MID.d : (MID[c] || MID.d)), 0);

/* a pair of tyre pressures in one text: the left value ending at lEnd, the
 * right starting at rStart, the gap made of em, en and plain spaces */
function pair(a, b, p) {
    const wa = midW(a);
    let gap = p.rStart - (p.lEnd - wa) - wa, pad = '';
    while (gap >= 30 && pad.length < 7) { pad += EM; gap -= 30; }
    if (gap >= 15) { pad += EN; gap -= 15; }
    while (gap >= 4 && pad.length + a.length + b.length < 16) { pad += ' '; gap -= 6; }
    return { text: a + pad + b, x: Math.round(p.rStart - wa - midW(pad)) };
}

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        st.kmh = st.kmh || new core.Spring(12);
        st.rpm = st.rpm || new core.Spring(16);
        const kmh = st.kmh.step(sig.kmh, ctx.dt), rpm = st.rpm.step(sig.rpm, ctx.dt);
        const out = {};

        /* the bands: fill and needle; the numerals brighten behind the needle */
        const mph = ok(kmh) ? kmh * MPH : null;
        out.speed = ok(mph) ? { visible: true, value: core.scale(mph, p.speedMap) } : { visible: false };
        out.spd = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        const cue = p.shiftCue;
        let revCol = C.rev;
        if (ok(rpm)) {
            const k = clamp((rpm - p.revWarm) / (cue - p.revWarm), 0, 1);
            revCol = rpm >= cue ? C.red : [1, lerp(168, 70, k) / 255, lerp(40, 38, k) / 255, 1];
        }
        out.tach = ok(rpm) ? { visible: true, value: core.scale(rpm, p.tachMap), color: revCol } : { visible: false };

        /* shift lights: pairs from both ends from shiftFrom; at the cue the row,
         * the lens outline and the chevron flash red at 3 Hz */
        const lit = ok(rpm) ? clamp(Math.floor((rpm - p.shiftFrom) / (cue - p.shiftFrom) * 6.999), 0, 6) : 0;
        const flashing = ok(rpm) && rpm >= cue && (!ok(sig.throttle) || sig.throttle > 0.5);
        const blink = flashing && Math.floor(ctx.t * 6) % 2 === 0;
        out.shift = flashing ? (blink ? { lit: 6, flash: 1 } : { lit: 6, flash: 2, uniforms: { u_off: C.redDim } })
            : { lit, flash: 0, uniforms: { u_off: C.none } };
        out.chevron = { color: blink ? C.red : C.none };
        ['lensL', 'lensR'].forEach((k) => { out[k] = { color: blink ? C.red : C.none }; });
        out.lensTop = { visible: blink };
        out.lensBot = { visible: blink };

        /* gear: M + the numeral; the strip below marks it */
        const g = sig.gear;
        out.gear = { text: !ok(g) ? '-' : g === 0 ? 'N' : String(g) };
        out.modeMask = { visible: sig.gearMode !== 'M' };
        const s = p.gearStrip;
        out.gearOn = ok(g) && g >= 1 && g <= 8 ? { visible: true, text: String(g), x: Math.round(s.x + (g - 4.5) * s.pitch - s.cell / 2) } : { visible: false };

        /* power: engine then electric along one bar; regen a hatch from zero */
        const eng = sig.engineHp, el = sig.elecHp;
        out.engHp = { text: ok(eng) ? String(Math.max(0, Math.round(eng))) : '--' };
        out.elHp = { text: ok(el) ? String(Math.abs(Math.round(el))) : '--' };
        out.elecLbl = { text: ok(el) && Math.round(el) < 0 ? 'REGEN' : 'ELECTRIC' };
        out.sysHp = { text: ok(eng) && ok(el) ? String(Math.max(0, Math.round(eng) + Math.max(0, Math.round(el)))) : '--' };
        const ew = ok(eng) ? clamp(Math.round(Math.max(0, eng) / 500 * 496), 0, 496) : 0;
        if (ok(el) && Math.round(el) < 0) {
            const lw = clamp(Math.abs(el) / 500 * 496, 0, 496);
            out.power = { uniforms: { u_led: [81, Math.round(lw / 6), 0, 0], u_geom: [496, 12, 3.4, 12], u_split: [0, 9999, 0, 0], u_lean: [12, 0, 0, 0] } };
        } else {
            const lw = ok(el) ? clamp(Math.round(el / 500 * 496), 0, 496 - ew) : 0;
            out.power = { uniforms: { u_led: [496, ew + lw, 0, 0], u_geom: [496, 12, 1, 12], u_split: [ew, 9999, 0, 0], u_lean: [0, 0, 0, 0] } };
        }

        /* tyres FL FR RL RR: psi, temperature and the pad in the state colour */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        const state = (c) => (!ok(c) ? C.ink3 : c < 45 ? C.cold : c < 85 ? C.ok : c < 98 ? C.warm : C.hot);
        const psi = (i) => fix(ok(ty(i).bar) ? ty(i).bar * PSI : null, 1);
        const pf = pair(psi(0), psi(1), p.psi), pr = pair(psi(2), psi(3), p.psi);
        out.psiF = { text: pf.text, x: pf.x };
        out.psiR = { text: pr.text, x: pr.x };
        ['tempFL', 'tempFR', 'tempRL', 'tempRR'].forEach((k, i) => {
            const c = ty(i).c;
            out[k] = { text: (ok(c) ? Math.round(c) : '--') + ' °C', color: state(c) };
        });
        const pads = (a, b) => ({ lit: ok(ty(a).c) && ok(ty(b).c) ? 2 : 0, uniforms: { u_c0: state(ty(a).c), u_c1: state(ty(b).c) } });
        out.padsF = pads(0, 1);
        out.padsR = pads(2, 3);

        /* fuel and range; oil and coolant */
        const fuel = sig.fuelPct;
        out.fuelPct = { text: num(fuel) + ' %' };
        out.fuelSegs = { lit: ok(fuel) ? clamp(Math.round(fuel / 10), 0, 10) : 0, uniforms: { u_c0: ok(fuel) && fuel < 15 ? C.warm : C.ink2 } };
        out.range = { text: num(sig.rangeKm, MPH) + ' mi' };
        out.oil = { text: num(sig.oilC) + ' °C' };
        out.oilBar = { lit: ok(sig.oilC) ? Math.round(clamp((sig.oilC - 50) / 100, 0, 1) * 168) : 0 };
        out.cool = { text: num(sig.coolantC) + ' °C' };

        /* the bottom row: battery, boost, lateral and longitudinal g */
        out.soc = { text: num(sig.socPct) };
        out.socBar = { lit: ok(sig.socPct) ? Math.round(36 * clamp(sig.socPct, 0, 100) / 100) : 0 };
        const b = ok(sig.boostBar) ? sig.boostBar * PSI : null;
        out.boost = { text: ok(b) ? (b < -0.05 ? MINUS : '') + Math.abs(b).toFixed(1) : '--' };
        const gl = sig.gLat;
        out.glat = { text: ok(gl) ? (gl < -0.005 ? 'L ' : gl > 0.005 ? 'R ' : '') + Math.abs(gl).toFixed(2) : '--' };
        const gn = sig.gLon;
        out.glong = { text: ok(gn) ? (gn < -0.005 ? MINUS : '') + Math.abs(gn).toFixed(2) : '--' };

        /* outside the lens: clock, outside temperature, odometer */
        out.clock = { text: sig.clock ? String(sig.clock) : '--:--' };
        const oc = ok(sig.outsideC) ? Math.round(sig.outsideC) : null;
        out.otemp = { text: (oc == null ? '--' : (oc < 0 ? MINUS : '') + Math.abs(oc)) + ' °C' };
        out.odo = { text: ok(sig.odoKm) ? String(Math.floor(sig.odoKm * MPH)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' mi' : '-- mi' };
        return out;
    },
};
