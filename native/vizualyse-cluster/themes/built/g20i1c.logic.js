// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// g20i1c "G20 inspired 1 · Comfort" (shader library v2): the G20 Comfort
// mockup's behaviour on the theme's layers. UK units (mph, miles, yards,
// mpg, psi, °C). A reading the source doesn't give shows as "--"; nothing is
// made up (the guidance, limit, cruise and economy readings are placeholders
// the car may not provide).
'use strict';

const MPH = 1.609344, PSI = 14.5038, MI = 1.609344, MPG = 282.481, KW = 0.7457;
const ok = (v) => v != null && isFinite(v);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const hhmm = (s) => (typeof s === 'string' && /^\d{1,2}:\d{2}$/.test(s) ? s : '--:--');

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state;
        const col = (c, a) => c.concat([a == null ? 1 : a]);
        st.speed = st.speed || new ctx.core.Spring(14);
        st.rpm = st.rpm || new ctx.core.Spring(16);
        st.pwr = st.pwr || new ctx.core.Spring(12);
        st.eco = st.eco || new ctx.core.Spring(6);
        const out = {};

        /* the bracket gauges: the scale is t0..t1 along the field; the glow
         * fades in over the scale's first 8 px */
        const g = p.gauge;
        const along = (k) => g.t0 + clamp(k, 0, 1) * (g.t1 - g.t0);
        const glow = (k) => col(C.calm, p.glow * clamp(k * (g.t1 - g.t0) * g.len / 8, 0, 1));
        const gauge = (k) => (ok(k) ? { value: along(k), glow: glow(k), needle: col(C.ink) } : { value: g.t0, glow: col(C.calm, 0), needle: col(C.ink, 0) });
        const mph = ok(sig.kmh) ? sig.kmh / MPH : null;
        const vMph = st.speed.step(mph, ctx.dt);
        const vRpm = st.rpm.step(sig.rpm, ctx.dt);
        out.speed = gauge(ok(vMph) ? vMph / p.maxMph : null);
        /* the engine off (electric running) reads 0 rpm: the needle rests at 0 */
        out.tach = gauge(ok(vRpm) ? vRpm / 1000 / p.maxKrpm : null);

        /* cruise: the set speed, as a pointer outside the speed outline */
        const set = ok(sig.cruiseKmh) ? sig.cruiseKmh / MPH : null;
        out.setPointer = set != null ? { value: along(set / p.maxMph), needle: col(C.ink) } : { needle: col(C.ink, 0) };
        out.cruiseText = set != null ? { text: String(Math.round(set)), color: col(C.ink) } : { text: '--', color: col(C.dim) };
        out.cruiseUnitCover = { visible: set == null };

        /* fuel and oil bars, from their low end */
        const fuelK = ok(sig.fuelPct) ? sig.fuelPct / 100 : null;
        out.fuel = ok(fuelK) ? { value: clamp(fuelK, 0.02, 1), color: col(C.line) } : { value: 0, color: col(C.line, 0) };
        const oilK = ok(sig.oilC) ? (sig.oilC - 70) / 80 : null;
        out.oil = ok(oilK)
            ? { value: clamp(oilK, 0.02, 1), color: col(sig.oilC < 85 ? C.dim : sig.oilC > 134 ? C.limit : C.line) }
            : { value: 0, color: col(C.line, 0) };

        /* economy now (left bar, 0-99 mpg): no fuel used (electric, coasting)
         * fills it and prints dim dashes, as the mockup does */
        const l100 = ok(sig.instL100) ? sig.instL100 : null;
        const mpgNow = l100 == null ? null : l100 < 0.05 ? p.ecoMaxMpg : MPG / l100;
        const eco = st.eco.step(mpgNow, ctx.dt);
        out.eco = { value: ok(eco) ? clamp(eco / p.ecoMaxMpg, 0, 1) : -0.01 };

        /* electric power (right bar, kW): up from its zero for drive, down for charging */
        const b = p.bar;
        const kw = st.pwr.step(ok(sig.elecHp) ? sig.elecHp * KW : null, ctx.dt);
        if (ok(kw) && kw > 0.3) out.power = { value: b.zero + clamp(kw / p.powerMaxKw, 0, 1) * (1 - b.zero), color: col(C.volt), uniforms: { u_seg: [0, 0, b.zero + b.gap, 1] } };
        else if (ok(kw) && kw < -0.3) out.power = { value: b.zero - clamp(-kw / p.chargeMaxKw, 0, 1) * b.zero, color: col(C.volt), uniforms: { u_seg: [0, 0, b.zero - b.gap, 1] } };
        else out.power = { value: b.zero, color: col(C.volt, 0) };

        /* the primary figures, every tick */
        out.speedText = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        const mode = sig.gearMode || '';
        out.gearText = { text: /^[DMSPRN]$/.test(mode) ? mode : '-' };
        out.gearNum = { text: /^[DMS]$/.test(mode) && ok(sig.gear) && sig.gear > 0 ? String(sig.gear) : '' };

        /* next manoeuvre: arrow, distance (yards under a quarter mile), road */
        const dir = sig.turnDir === 'left' || sig.turnDir === 'right' ? sig.turnDir : null;
        out.turnCoverL = { visible: dir !== 'left' };
        out.turnCoverR = { visible: dir !== 'right' };
        out.turnCoverStem = { visible: dir == null };

        /* second-glance numbers change ten times a second, as in the mockup */
        if (st.slowT != null && ctx.t - st.slowT < 0.1 && ctx.t >= st.slowT) return Object.assign(out, st.slow);
        st.slowT = ctx.t;
        const s = {};
        const m = ok(sig.turnM) ? sig.turnM : null;
        if (m == null) { s.distText = { text: '--' }; s.distUnit = { text: '' }; }
        else if (m >= MI * 1000 / 4) { s.distText = { text: (m / 1000 / MI).toFixed(1) }; s.distUnit = { text: 'mi' }; }
        else { s.distText = { text: String(Math.max(50, Math.round(m * 1.09361 / 50) * 50)) }; s.distUnit = { text: 'yd' }; }
        s.roadText = { text: typeof sig.road === 'string' && sig.road ? sig.road.slice(0, 16) : '--' };

        s.limitText = { text: ok(sig.limitKmh) ? String(Math.round(sig.limitKmh / MPH)) : '--' };
        s.rpmText = { text: ok(sig.rpm) ? String(Math.round(sig.rpm / 50) * 50) : '--' };
        s.avgText = { text: ok(sig.avgL100) && sig.avgL100 > 0.05 ? (MPG / sig.avgL100).toFixed(1) : '--' };
        s.ecoText = l100 != null && l100 >= 0.05 ? { text: String(Math.round(Math.min(p.ecoMaxMpg, MPG / l100))), color: col(C.ink) } : { text: '--', color: col(C.dim) };
        s.powerText = { text: ok(sig.elecHp) ? String(Math.round(Math.abs(sig.elecHp * KW))) : '--' };
        s.powerLabel = { text: ok(sig.elecHp) && sig.elecHp < -1 ? 'CHARGING' : 'ELECTRIC' };
        s.etaText = { text: hhmm(sig.eta) };
        s.toGoText = { text: ok(sig.destKm) ? (sig.destKm / MI).toFixed(1) : '--' };

        s.socCells = { lit: ok(sig.socPct) ? Math.round(sig.socPct / 5) : 0 };
        s.socText = { text: num(sig.socPct) };
        s.evRangeText = { text: num(sig.evRangeKm, 1 / MI) };

        s.rangeText = { text: num(sig.rangeKm, 1 / MI) };
        s.clockText = { text: hhmm(sig.clock) };
        s.tripText = { text: ok(sig.tripKm) ? (sig.tripKm / MI).toFixed(1) : '--' };
        /* tyres: front and rear pressure (each axle's mean) */
        const ty = Array.isArray(sig.tyres) ? sig.tyres : [];
        const axle = (i, j) => (ty[i] && ty[j] && ok(ty[i].bar) && ok(ty[j].bar) ? String(Math.round((ty[i].bar + ty[j].bar) / 2 * PSI)) : '--');
        s.tyresText = { text: axle(0, 1) + ' / ' + axle(2, 3) };
        s.outsideText = { text: ok(sig.outsideC) ? (sig.outsideC < -0.05 ? '-' : '+') + Math.abs(sig.outsideC).toFixed(1) : '--' };
        s.oilText = { text: num(sig.oilC) };
        st.slow = s;
        return Object.assign(out, s);
    },
};
