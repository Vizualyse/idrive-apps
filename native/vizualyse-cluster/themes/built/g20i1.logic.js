// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// g20i1 "G20 inspired 1" (shader library v2): the G20 Sport mockup's
// behaviour on the theme's layers. UK units (mph, miles, psi, °C). A reading
// the source doesn't give shows as "--"; nothing is made up.
'use strict';

const MPH = 1.609344, PSI = 14.5038, MI = 1.609344;
const ok = (v) => v != null && isFinite(v);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state;
        const col = (c, a) => c.concat([a == null ? 1 : a]);
        st.speed = st.speed || new ctx.core.Spring(14);
        st.rpm = st.rpm || new ctx.core.Spring(16);
        st.eng = st.eng || new ctx.core.Spring(12);
        st.ele = st.ele || new ctx.core.Spring(12);
        const out = {};

        /* the bracket gauges: the scale is t0..t1 along the field */
        const g = p.gauge;
        const along = (k) => g.t0 + clamp(k, 0, 1) * (g.t1 - g.t0);
        const mph = ok(sig.kmh) ? sig.kmh / MPH : null;
        const vMph = st.speed.step(mph, ctx.dt);
        const vRpm = st.rpm.step(sig.rpm, ctx.dt);
        /* the glow fades in over the scale's first 8 px (at its very start the
         * trail is a 1 px line across the whole glow depth) */
        const glow = (k) => col(C.sport, p.glow * clamp(k * (g.t1 - g.t0) * g.len / 8, 0, 1));
        const gauge = (k) => (ok(k) ? { value: along(k), glow: glow(k), needle: col(C.ink) } : { value: g.t0, glow: col(C.sport, 0), needle: col(C.ink, 0) });
        out.speed = gauge(ok(vMph) ? vMph / p.maxMph : null);
        out.tach = gauge(ok(vRpm) ? vRpm / 1000 / p.maxKrpm : null);

        /* fuel and oil bars, from their low end */
        const fuelK = ok(sig.fuelPct) ? sig.fuelPct / 100 : null;
        out.fuel = ok(fuelK) ? { value: clamp(fuelK, 0.02, 1), color: col(C.line) } : { value: 0, color: col(C.line, 0) };
        const oilK = ok(sig.oilC) ? (sig.oilC - 70) / 80 : null;
        out.oil = ok(oilK)
            ? { value: clamp(oilK, 0.02, 1), color: col(sig.oilC < 85 ? C.dim : sig.oilC > 134 ? C.sport : C.line) }
            : { value: 0, color: col(C.line, 0) };

        /* power bars: engine from the bottom; electric from its zero a quarter
         * up, upward for drive and downward for regeneration (a 2 px gap at
         * the zero keeps the art's zero tick clear) */
        const b = p.bar;
        const eng = st.eng.step(ok(sig.engineHp) ? Math.max(0, sig.engineHp) : null, ctx.dt);
        out.engine = { value: ok(eng) ? clamp(eng / p.engineMaxHp, 0, 1) : 0 };
        const ele = st.ele.step(sig.elecHp, ctx.dt);
        if (ok(ele) && ele > 0.5) out.electric = { value: b.zero + clamp(ele / p.electricMaxHp, 0, 1) * (1 - b.zero), color: col(C.volt), uniforms: { u_seg: [0, 0, b.zero + b.gap, 1] } };
        else if (ok(ele) && ele < -0.5) out.electric = { value: b.zero - clamp(-ele / p.regenMaxHp, 0, 1) * b.zero, color: col(C.volt), uniforms: { u_seg: [0, 0, b.zero - b.gap, 1] } };
        else out.electric = { value: b.zero, color: col(C.volt, 0) };

        /* shift lights: seven pairs from the outside in, 4,700 to 6,000 rpm
         * (four amber, three red); all red at the shift point under throttle,
         * with the gear red and the chevrons shown */
        const rpm = sig.rpm;
        const cue = ok(rpm) && rpm >= p.shiftRpm && (!ok(sig.throttle) || sig.throttle > 0.5) && !(sig.gear >= p.topGear);
        const k = !ok(rpm) ? 0 : cue ? 7 : Math.floor(clamp((rpm - p.shiftFrom) / (p.shiftRpm - p.shiftFrom), 0, 0.999) * 7);
        out.shift = { lit: k, flash: cue ? 1 : 0 };
        out.chevCover = { visible: !cue };

        /* the primary figures, every tick */
        out.speedText = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        const mode = sig.gearMode || '';
        let gear = '-';
        if (/^[PRN]$/.test(mode)) gear = mode;
        else if (ok(sig.gear)) gear = sig.gear === 0 ? 'N' : String(sig.gear);
        out.gearText = { text: gear, color: cue ? col(C.sport) : col(C.ink) };
        out.prefixText = { text: /^[MDS]$/.test(mode) && /^\d/.test(gear) ? mode : '' };

        /* g-force dot: lateral to the side, acceleration pushes it back (down) */
        const gl = ok(sig.gLat) ? sig.gLat : null, gn = ok(sig.gLon) ? sig.gLon : null;
        if (gl != null && gn != null) out.gDot = { visible: true, x: 954 + clamp(gl, -1.2, 1.2) * 21, y: 303 + clamp(gn, -1.2, 1.2) * 21 };
        else out.gDot = { visible: false };

        /* second-glance numbers change ten times a second, as in the mockup */
        if (st.slowT != null && ctx.t - st.slowT < 0.1 && ctx.t >= st.slowT) return Object.assign(out, st.slow);
        st.slowT = ctx.t;
        const s = {};
        s.kmhText = { text: num(sig.kmh) };
        s.rpmText = { text: ok(rpm) ? String(Math.round(rpm / 50) * 50) : '--' };
        s.boostText = { text: ok(sig.boostBar) ? String(Math.round(Math.max(0, sig.boostBar) * PSI)) : '--' };
        s.engineText = { text: ok(sig.engineHp) ? String(Math.round(Math.max(0, sig.engineHp))) : '--' };
        s.electricText = { text: ok(sig.elecHp) ? String(Math.round(Math.abs(sig.elecHp))) : '--' };
        s.electricLabel = { text: ok(sig.elecHp) && sig.elecHp < -1 ? 'CHARGING' : 'ELECTRIC' };
        s.gText = { text: gl != null && gn != null ? Math.hypot(gl, gn).toFixed(1) : '--' };

        /* tyres: pressure and temperature, the front pair and the rear pair on
         * one layer each (the gap between them in em/en spaces) */
        const ty = Array.isArray(sig.tyres) ? sig.tyres : [];
        const psi = (i) => (ty[i] && ok(ty[i].bar) ? String(Math.round(ty[i].bar * PSI)) : '--');
        const tc = (i) => (ty[i] && ok(ty[i].c) ? Math.round(ty[i].c) + '°' : '--');
        s.psiFront = { text: psi(0) + p.psiGap + psi(1) };
        s.psiRear = { text: psi(2) + p.psiGap + psi(3) };
        s.tempFront = { text: tc(0) + p.tempGap + tc(1) };
        s.tempRear = { text: tc(2) + p.tempGap + tc(3) };
        ['tyreFL', 'tyreFR', 'tyreRL', 'tyreRR'].forEach((name, i) => {
            const c = ty[i] && ok(ty[i].c) ? ty[i].c : null;
            /* cold is hollow: the track fill with a dim ring; then dim, amber
             * from 54, red from 70, each with the mockup's black edge */
            if (c == null) s[name] = { color: col(C.dim, 0), ring: [0, 0, 0, 0] };
            else if (c < 30) s[name] = { color: col(C.track), ring: col(C.dim) };
            else s[name] = { color: col(c < 54 ? C.dim : c < 70 ? C.amber : C.sport), ring: [0, 0, 0, 1] };
        });

        /* battery: cells one per 5 %, percent and electric range */
        s.socCells = { lit: ok(sig.socPct) ? Math.round(sig.socPct / 5) : 0 };
        s.socText = { text: num(sig.socPct) };
        s.evRangeText = { text: num(sig.evRangeKm, 1 / MI) };

        /* info line */
        s.rangeText = { text: num(sig.rangeKm, 1 / MI) };
        s.clockText = { text: typeof sig.clock === 'string' && /^\d{1,2}:\d{2}$/.test(sig.clock) ? sig.clock : '--:--' };
        /* 0-60 mph: measured from a standstill on the car's own speed */
        if (ok(sig.kmh)) {
            if (sig.kmh < 0.5) st.launch = { t: null };
            else if (st.launch && st.launch.t == null) st.launch.t = ctx.t;
            if (st.launch && st.launch.t != null && sig.kmh / MPH >= 60) { st.z60 = ctx.t - st.launch.t; st.launch = null; }
        }
        s.z60Text = { text: ok(st.z60) && st.z60 > 0 ? st.z60.toFixed(1) : '--' };
        s.coolantText = { text: num(sig.coolantC) };
        s.outsideText = { text: ok(sig.outsideC) ? (sig.outsideC < -0.05 ? '-' : '+') + Math.abs(sig.outsideC).toFixed(1) : '--' };
        s.oilText = { text: num(sig.oilC) };
        st.slow = s;
        return Object.assign(out, s);
    },
};
