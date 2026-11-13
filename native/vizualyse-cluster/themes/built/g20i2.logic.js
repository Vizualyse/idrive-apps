// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// G20 inspired 2: speed and revs along the chamfered frames with a red wake
// (added to the art) and a pool of light at a short orange pointer, gapped
// shift lamps along the tach's top edge (amber, orange, red, all flashing at
// the cue), engine and electric power on curved bars, M + gear, tyres on the
// car plan, fuel and oil. UK units: mph, miles, psi, deg C. A reading the
// source does not give shows "--".
'use strict';
const MPH = 0.621371, PSI = 14.5038;

const ok = (v) => v != null && isFinite(v);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        st.kmh = st.kmh || new core.Spring(12);
        st.rpm = st.rpm || new core.Spring(18);
        st.eng = st.eng || new core.Spring(10);
        st.ele = st.ele || new core.Spring(10);
        const kmh = st.kmh.step(sig.kmh, ctx.dt), rpm = st.rpm.step(sig.rpm, ctx.dt);
        const eng = st.eng.step(sig.engineHp, ctx.dt), ele = st.ele.step(sig.elecHp, ctx.dt);
        const out = {};

        /* speed and revs: the pointer, its wake and pool along the frame */
        /* the path starts a little before the scale (speedT0); the light fades in over its first 60 px */
        const along = (f) => {
            const glow = [1, 0.3, 0.07, 1.2 * clamp(f * (1 - p.speedT0) * p.scaleLen / 60, 0, 1)];
            return { visible: true, value: lerp(p.speedT0, 1, f), glow };
        };
        out.speed = ok(kmh) ? along(core.scale(kmh * MPH, p.speedMap)) : { visible: false };
        out.tach = ok(rpm) ? along(core.scale(rpm / 1000, p.tachMap)) : { visible: false };
        out.kmh = { text: num(kmh, MPH) };
        out.rpm = { text: ok(rpm) ? thousands(Math.round(rpm / 10) * 10) : '--' };

        /* shift lamps: one more lit per 165 rpm from 4.6k, all flashing red at the cue (2.5 Hz) */
        const cue = ok(rpm) && rpm >= p.shiftCue;
        const flashOn = cue && Math.floor(ctx.t * 5) % 2 === 0;
        const n = p.lamps;
        const lit = ok(rpm) ? clamp(Math.floor((rpm - p.lampFrom) / ((p.lampTo - p.lampFrom) / n) + 0.5), 0, n) : 0;
        const lampV = cue ? (flashOn ? p.lampT1 : 0) : p.lampT1 * lit / n;
        out.lampsA = { value: lampV, color: cue ? C.red : C.amber, red: cue ? C.red : C.orange,
            glow: cue ? [1, 0.14, 0.08, 0.75] : [1, 0.33, 0.08, 0.6] };
        out.lampsB = { value: lampV };
        out.chevron = { visible: cue, color: flashOn ? C.red : C.chevDim };

        /* gear: the mode letter and the numeral, red with the cue */
        const g = sig.gear;
        out.gear = { text: !ok(g) ? '-' : g === 0 ? 'N' : String(g), color: cue ? C.sport : C.ink };
        out.mode = { text: sig.gearMode ? String(sig.gearMode).slice(0, 1) : '' };

        /* power: engine fills up from the bottom; electric from its zero, up (drive) or down (regen) */
        const B = p.barT;
        out.eng = { value: ok(eng) ? lerp(B.eng0, B.eng1, clamp(eng / p.engMaxHp, 0, 1)) : 0 };
        out.engHp = { text: num(eng) };
        if (ok(ele)) {
            const f = clamp((ele - p.eleMinHp) / (p.eleMaxHp - p.eleMinHp), 0, 1);
            const r = Math.round(ele);
            out.ele = { visible: r !== 0, value: lerp(B.eleBottom, B.eleTop, f), color: ele >= 0 ? C.edrive : C.regen };
            out.eleHp = { text: (r < 0 ? '−' : '') + Math.abs(r) };
        } else {
            out.ele = { visible: false };
            out.eleHp = { text: '--' };
        }

        /* HV battery */
        out.soc = { lit: ok(sig.socPct) ? Math.round(sig.socPct / 5) : 0 };
        out.socPct = { text: num(sig.socPct) + ' %' };
        out.evRange = { text: 'E ' + num(sig.evRangeKm, MPH) + ' mi' };

        /* fuel up its arc; the range below */
        out.fuel = ok(sig.fuelPct) ? { visible: true, value: clamp(sig.fuelPct / 100, 0, 1) } : { visible: false };
        out.range = { text: num(sig.rangeKm, MPH) + ' mi' };

        /* oil: a mark along its arc, 50..150 deg C */
        if (ok(sig.oilC)) {
            const o = p.oil, a = lerp(o.a0, o.a1, clamp((sig.oilC - o.from) / (o.to - o.from), 0, 1)) * Math.PI / 180;
            out.oilMark = { visible: true, x: o.cx + o.r * Math.cos(a) - 10, y: o.cy + o.r * Math.sin(a) - 3.5 };
        } else out.oilMark = { visible: false };
        out.oilC = { text: num(sig.oilC) + ' °C' };

        /* tyres FL FR RL RR: pressure in psi, temperature, the tyre red when hot; a note when cold */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        let cold = false;
        ['FL', 'FR', 'RL', 'RR'].forEach((k, i) => {
            out['psi' + k] = { text: num(ty(i).bar, PSI) };
            out['temp' + k] = { text: num(ty(i).c) + ' °C' };
            out['tyreHot' + i] = { visible: ok(ty(i).c) && ty(i).c > p.tyreHotC };
            if (ok(ty(i).c) && ty(i).c < p.tyreColdC) cold = true;
        });
        out.coldNote = { text: cold ? 'COLD TYRES' : '' };

        /* status row */
        out.clock = { text: sig.clock ? String(sig.clock).slice(0, 5) : '--:--' };
        out.odo = { text: (ok(sig.odoKm) ? thousands(Math.floor(sig.odoKm * MPH)) : '--') + ' mi' };
        out.outside = { text: (ok(sig.outsideC) ? (sig.outsideC >= 0 ? '+' : '−') + Math.abs(sig.outsideC).toFixed(1) : '--') + ' °C' };
        return out;
    },
};
