// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// Performance 2 (Sport): the Performance mockup's behaviour on the theme's
// layers. One ramp for the rev trail and the shift lamps (white, amber,
// red), both flashing red with the tach's bezel at the shift point, the
// SHIFT cue and a red gear; the speed trail fading in from its start; the
// power split with regen hatched left of zero; tyres on the car plan by
// temperature; the g dot; fuel, battery, temperatures. UK units: mph,
// miles, psi, deg C (boost in bar, as the mockup). A reading the source
// does not give shows "--"; nothing is made up.
'use strict';
const MPH = 0.621371, PSI = 14.5038;
const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const col = (c, a) => [c[0], c[1], c[2], a == null ? c[3] : a];
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const MINUS = '−';
const signed = (v, plus) => (Math.round(v) < 0 ? MINUS : Math.round(v) > 0 && plus ? '+' : '') + Math.abs(Math.round(v));

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        if (!st.kmh) {
            st.kmh = new core.Spring(14); st.rpm = new core.Spring(22);
            st.eng = new core.Spring(12); st.ele = new core.Spring(12); st.boost = new core.Spring(10);
            st.gx = new core.Spring(10); st.gy = new core.Spring(10);
        }
        const out = {};
        const len = p.dialLen;

        /* ---- the dials ---- */
        const mph = ok(sig.kmh) ? sig.kmh * MPH : null;
        const vMph = st.kmh.step(mph, ctx.dt);
        const vRpm = st.rpm.step(sig.rpm, ctx.dt);
        const rpm = sig.rpm;
        const cue = ok(rpm) && rpm >= p.shiftRpm && (!ok(sig.throttle) || sig.throttle > 0.5) && !(sig.gear >= p.topGear);
        if (cue && st.cueT == null) st.cueT = ctx.t;
        if (!cue) st.cueT = null;
        /* 0.17 s a phase, as the mockup (just under 3 Hz) */
        const flashOn = !cue || Math.floor(Math.max(0, ctx.t - st.cueT) / 0.17) % 2 === 0;

        /* the speed trail: lit from 0, fading in along the swept part, the glow trailing all of it */
        if (ok(vMph)) {
            const f = clamp(vMph / p.maxMph, 0, 1);
            /* the mockup's trail brightens toward the needle: the first half of the swept part dim, the rest bright */
            out.speed = { visible: true, uniforms: { u_val: [f, len, f * 0.5, Math.max(f, 0.01)] } };
        } else out.speed = { visible: false };

        const tAmber = p.amberRpm / p.maxRpm, tRed = p.redStageRpm / p.maxRpm;
        if (ok(vRpm)) {
            const f = clamp(vRpm / p.maxRpm, 0, 1);
            const u = { u_val: [f, len, tAmber, Math.max(f, 0.01)] };
            if (cue) {
                const a = flashOn ? 1 : 0.25;
                /* the whole trail red (or dim), the needle on this layer while tachRed lights the whole bezel */
                out.tach = { visible: true, color: col(C.red, a), red: col(C.red, a), glow: col(C.glowRed, flashOn ? 1 : 0.3), needle: C.red, uniforms: u };
                out.tachRed = { visible: flashOn, color: col(C.red, 0.85), red: col(C.red, 0.85), needle: C.none,
                    uniforms: { u_val: [1, len, 2, 0], u_band: [-19.5, -16.5, -12, 46], u_seg: [0, 0, 0, 1] } };
            } else {
                out.tach = { visible: true, color: col(C.cool, 0.45), red: C.amber, glow: C.glow, needle: C.none, uniforms: u };
                out.tachRed = { visible: true, color: C.none, red: C.red, needle: C.red,
                    uniforms: { u_val: [f, len, tRed, 0], u_band: [-6, 6, -12, 46], u_seg: [0, 0, 0, 1] } };
            }
        } else {
            out.tach = { visible: false };
            out.tachRed = { visible: false };
        }

        /* ---- shift lamps: 8 rings from the ends in, lampFrom to the shift point; all red, flashing, at the cue ---- */
        const lit = ok(vRpm) ? Math.floor(clamp((vRpm - p.lampFrom) / (p.shiftRpm - p.lampFrom) * 8, 0, 8) + 1e-4) : 0;
        out.shift = { lit: cue ? 8 : lit, flash: cue ? (flashOn ? 1 : 2) : 0, uniforms: { u_off: cue ? C.flashOff : C.trackDim } };
        out.cueCover = { visible: !cue };

        /* ---- the figures in the dials ---- */
        out.speedText = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        out.rpmText = { text: ok(vRpm) ? thousands(Math.round(vRpm / 10) * 10) : '--' };
        const mode = sig.gearMode || '';
        let gear = '--';
        if (/^[PRN]$/.test(mode)) gear = mode;
        else if (ok(sig.gear)) gear = sig.gear === 0 ? 'N' : (/^[MDS]$/.test(mode) ? mode : '') + sig.gear;
        /* a new gear drops 14 px into place over 140 ms, from 35 % */
        if (st.gear !== undefined && st.gear !== gear) st.gearT = ctx.t;
        st.gear = gear;
        const k = st.gearT == null ? 1 : clamp((ctx.t - st.gearT) / 0.14, 0, 1), e = 1 - Math.pow(1 - k, 3);
        out.gearText = { text: gear, y: p.gearY + 14 * (1 - e), color: col(cue ? C.red : C.ink, 0.35 + 0.65 * e) };

        /* ---- power: engine from zero, electric deploy after it, regen hatched left of zero ---- */
        const B = p.bars;
        const tp = (hp) => clamp((hp - B.pMin) / (B.pMax - B.pMin), 0, 1) * B.pT1;
        const t0 = tp(0);
        const eng = st.eng.step(ok(sig.engineHp) ? Math.max(0, sig.engineHp) : null, ctx.dt);
        const ele = st.ele.step(sig.elecHp, ctx.dt);
        if (ok(eng) || ok(ele)) {
            const E = ok(eng) ? eng : 0, L = ok(ele) ? ele : 0;
            if (L < -0.5) {
                /* regen: blue in 6 px stripes with 3 px gaps from zero to the regen; engine (if any) on the right */
                const start = E > 0.5 ? tp(L) : t0, value = E > 0.5 ? tp(E) : tp(L);
                out.power = { color: C.blue, red: C.cool, uniforms: { u_val: [value, B.len, E > 0.5 ? t0 : 2, 0], u_seg: [60, 3, start, start + 540 / B.len] } };
            } else {
                out.power = { color: C.cool, red: C.blue, uniforms: { u_val: [tp(E + L), B.len, tp(E), 0], u_seg: [0, 0, t0, 1] } };
            }
        } else out.power = { uniforms: { u_val: [t0, B.len, 2, 0], u_seg: [0, 0, t0, 1] } };
        const total = ok(eng) || ok(ele) ? (ok(eng) ? eng : 0) + (ok(ele) ? ele : 0) : null;
        out.powerText = { text: ok(total) && ok(eng) ? signed(total) : '--' };
        out.engText = { text: ok(eng) ? String(Math.round(eng)) : '--' };
        out.eleText = { text: ok(ele) ? signed(ele, true) : '--' };

        const boost = st.boost.step(sig.boostBar, ctx.dt);
        const tb = (b) => B.bT0 + (B.bMax - clamp(b, B.bMin, B.bMax)) / (B.bMax - B.bMin) * (B.bT1 - B.bT0);
        out.boost = ok(boost) ? { visible: true, uniforms: { u_val: [tb(boost), B.len, 2, 0], u_seg: [0, 0, tb(0), 1] } } : { visible: false };
        out.boostText = { text: ok(boost) ? (boost < -0.005 ? MINUS : '') + Math.abs(boost).toFixed(2) : '--' };

        /* ---- chassis: tyres by temperature (cold hollow, warm frost, hot amber), the g dot ---- */
        const ty = Array.isArray(sig.tyres) ? sig.tyres : [];
        const cls = (k) => (ty[k] && ok(ty[k].c) ? (Math.round(ty[k].c) < p.tyreCold ? 0 : Math.round(ty[k].c) > p.tyreHot ? 2 : 1) : -1);
        const fillOf = (c) => (c === 1 ? C.cool : c === 2 ? C.amber : C.none);
        const textOf = (c) => (c === 2 ? C.amber : c === 1 ? C.ink : C.ink2);
        ['FL', 'FR', 'RL', 'RR'].forEach((n, k) => {
            out['psi' + n] = { text: ty[k] && ok(ty[k].bar) ? (ty[k].bar * PSI).toFixed(1) : '--' };
            out['temp' + n] = { text: ty[k] && ok(ty[k].c) ? String(Math.round(ty[k].c)) : '--', color: textOf(cls(k)) };
        });
        out.wheelsF = { uniforms: { u_c0: fillOf(cls(0)), u_c1: fillOf(cls(1)) } };
        out.wheelsR = { uniforms: { u_c0: fillOf(cls(2)), u_c1: fillOf(cls(3)) } };
        if (ok(sig.gLat) && ok(sig.gLon)) {
            const g = p.g;
            const gx = st.gx.step(clamp(sig.gLat, -g.max, g.max) * g.k, ctx.dt), gy = st.gy.step(clamp(-sig.gLon, -g.max, g.max) * g.k, ctx.dt);
            out.gDot = { visible: true, x: g.cx + gx - 9, y: g.cy + gy - 9 };
            out.gText = { text: Math.hypot(sig.gLat, sig.gLon).toFixed(2) };
        } else {
            out.gDot = { visible: false };
            out.gText = { text: '--' };
        }

        /* ---- fuel, range, temperatures, battery, the top row ---- */
        const fuel = ok(sig.fuelPct) ? sig.fuelPct : null;
        out.fuel = { lit: ok(fuel) ? Math.round(fuel / 100 * 24) : 0,
            uniforms: { u_c0: ok(fuel) && fuel < p.fuelLowPct ? C.amber : C.cool } };
        out.rangeText = { text: ok(sig.rangeKm) ? thousands(Math.round(sig.rangeKm * MPH)) : '--' };
        const mark = (v, m) => (ok(v) ? { visible: true, x: m.x + clamp((v - m.lo) / (m.hi - m.lo), 0, 1) * m.w - 1.5 } : { visible: false });
        out.oilText = { text: num(sig.oilC) };
        out.oilMark = mark(sig.oilC, p.oil);
        out.coolText = { text: num(sig.coolantC) };
        out.coolMark = mark(sig.coolantC, p.cool);
        out.hvText = { text: num(sig.socPct) };
        out.hv = { lit: ok(sig.socPct) ? Math.round(sig.socPct / 100 * 24) : 0 };
        out.hvState = { text: !ok(sig.elecHp) ? '--' : sig.elecHp < -0.5 ? 'REGEN' : sig.elecHp > 20 ? 'DEPLOY' : 'HOLD' };
        const clock = typeof sig.clock === 'string' && /^\d{1,2}:\d\d$/.test(sig.clock) ? sig.clock : '--:--';
        out.topText = { text: clock + '    ' + (ok(sig.outsideC) ? signed(sig.outsideC) : '--') };
        return out;
    },
};
