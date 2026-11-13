// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// Performance 2 · Comfort: the Performance Comfort mockup's behaviour on the
// theme's layers. Both trails a quiet Frost fade with white needles, the rev
// needle gliding (damped slowly); the cruise notch at the set speed and the
// limit sign; D with the gear beside it, ELECTRIC while the engine is off;
// the demand bar (engine, electric, charge hatched left of zero) with its
// zone word lit; guidance (turn arrow, distance, road, arrival); fuel,
// coolant, tyres, battery, trip. UK units: mph, miles, yards, mpg, psi, deg C.
// A reading the source does not give shows "--"; nothing is made up.
'use strict';
const MPH = 0.621371, PSI = 14.5038, YD = 1.09361, MPG = 282.481;
const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const MINUS = '−';

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        if (!st.kmh) {
            st.kmh = new core.Spring(12);
            /* the mockup's rev needle follows at 5/s: shifts and engine stops glide */
            st.rpm = new core.Spring(6);
            st.dem = new core.Spring(8);
        }
        const out = {};
        const len = p.dialLen;

        /* ---- the dials: Frost fades, white needles ---- */
        const mph = ok(sig.kmh) ? sig.kmh * MPH : null;
        const vMph = st.kmh.step(mph, ctx.dt);
        const vRpm = st.rpm.step(sig.rpm, ctx.dt);
        const trail = (f) => ({ u_v: [f, len, f * 0.5, Math.max(f, 0.01)] });
        out.speed = ok(vMph) ? { visible: true, uniforms: trail(clamp(vMph / p.maxMph, 0, 1)) } : { visible: false };
        out.tach = ok(vRpm) ? { visible: true, uniforms: trail(clamp(vRpm / p.maxRpm, 0, 1)) } : { visible: false };
        /* cruise: the notch at the set speed while it is on; null is off */
        const cruise = ok(sig.cruiseKmh) && sig.cruiseKmh > 0 ? sig.cruiseKmh * MPH : null;
        out.cruise = ok(cruise) ? { visible: true, uniforms: { u_v: [clamp(cruise / p.maxMph, 0, 1), len, 2, 0] } } : { visible: false };
        out.cruiseText = ok(cruise) ? { text: Math.round(cruise) + ' mph', color: C.ink } : { text: 'off', color: C.ink3 };
        out.limitText = { text: ok(sig.limitKmh) ? String(Math.round(sig.limitKmh * MPH / 5) * 5) : '--' };

        out.speedText = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        /* the engine off: ELECTRIC in the cue's place, the rpm figures grey */
        const engineOff = ok(sig.rpm) && sig.rpm < 100;
        out.evCover = { visible: !engineOff };
        out.rpmText = { text: ok(vRpm) ? thousands(Math.round(Math.max(0, vRpm) / 10) * 10) : '--', color: engineOff ? C.ink2 : C.ink };
        const mode = sig.gearMode || '';
        out.gearL = { text: /^[DMSPRN]$/.test(mode) ? mode : ok(sig.gear) && sig.gear === 0 ? 'N' : '--' };
        out.gearN = { text: /^[PRN]$/.test(mode) || !ok(sig.gear) || sig.gear === 0 ? '' : String(sig.gear) };

        /* ---- demand: -0.5 (charge) .. 0 .. eco .. 1 (power), from the system's power ---- */
        const B = p.bars;
        const eng = ok(sig.engineHp) ? Math.max(0, sig.engineHp) : null, ele = ok(sig.elecHp) ? sig.elecHp : null;
        const dRaw = ok(eng) || ok(ele) ? ((eng || 0) + (ele || 0)) / p.demandHp : null;
        const d = st.dem.step(ok(dRaw) ? clamp(dRaw, B.dMin, B.dMax) : null, ctx.dt);
        const td = (v) => (clamp(v, B.dMin, B.dMax) - B.dMin) / (B.dMax - B.dMin);
        const t0 = td(0);
        if (ok(d) && d < -0.004) {
            /* charging: blue in 6 px stripes with 3 px gaps, left of zero */
            out.demand = { color: C.blue, uniforms: { u_v: [td(d), B.len, 2, 0], u_seg: [60, 3, t0, t0 + 540 / B.len] } };
        } else if (ok(d)) {
            /* the electric share of the demand continues the engine's in blue */
            const eShare = ok(ele) && ele > 0 && dRaw > 0 ? clamp(ele / ((eng || 0) + ele), 0, 1) : 0;
            out.demand = { color: C.cool, red: C.blue, uniforms: { u_v: [td(d), B.len, td(d * (1 - eShare)), 0], u_seg: [0, 0, t0, 1] } };
        } else out.demand = { uniforms: { u_v: [t0, B.len, 2, 0], u_seg: [0, 0, t0, 1] } };
        const zone = !ok(d) ? -1 : d < -0.02 ? 0 : d <= p.eco ? 1 : 2;
        out.zoneC = { text: 'CHARGE', color: zone === 0 ? C.blue : C.ink3 };
        out.zoneE = { text: 'ECO', color: zone === 1 ? C.ink : C.ink3 };
        out.zoneP = { text: 'POWER', color: zone === 2 ? C.ink : C.ink3 };
        out.mpgText = { text: ok(sig.avgL100) && sig.avgL100 > 0 ? (MPG / sig.avgL100).toFixed(1) : '--' };

        /* ---- guidance ---- */
        const dir = sig.turnDir;
        out.arrowTurn = dir === 'left' || dir === 'right' ? { visible: true, uniforms: { u_pool: [0, 0, 0, dir === 'left' ? 1 : 0] } } : { visible: false };
        out.arrowStem = { visible: dir === 'straight' };
        out.arrowHead = { visible: dir === 'straight' };
        if (ok(sig.turnM)) {
            const mi = sig.turnM / 1609.344;
            if (mi < 0.3) out.distText = { text: String(Math.max(50, Math.round(sig.turnM * YD / 50) * 50)) }, out.distUnit = { text: 'yd' };
            else out.distText = { text: mi.toFixed(1) }, out.distUnit = { text: 'mi' };
        } else { out.distText = { text: '--' }; out.distUnit = { text: '' }; }
        /* the unit follows the figures (the font's advances: digits 24 px, '.' 12, ',' 11, '-' 17) */
        const A = p.distAdv;
        out.distUnit.x = A.x + A.gap + out.distText.text.split('').reduce((w, c) => w + (A[c] || A.digit), 0);
        out.roadText = { text: typeof sig.road === 'string' && sig.road ? sig.road.slice(0, 16) : '--' };
        const eta = typeof sig.eta === 'string' && /^\d{1,2}:\d\d$/.test(sig.eta) ? sig.eta : '--:--';
        out.etaText = { text: eta + ' · ' + num(sig.destKm, MPH) + ' mi' };

        /* ---- fuel, coolant, tyres, battery, trip, the top row ---- */
        const fuel = ok(sig.fuelPct) ? sig.fuelPct : null;
        out.fuel = { lit: ok(fuel) ? Math.round(fuel / 100 * 24) : 0, uniforms: { u_c0: ok(fuel) && fuel < p.fuelLowPct ? C.amber : C.cool } };
        out.rangeText = { text: ok(sig.rangeKm) ? thousands(Math.round(sig.rangeKm * MPH)) : '--' };
        out.coolText = { text: num(sig.coolantC) };
        out.coolMark = ok(sig.coolantC) ? { visible: true, x: p.cool.x + clamp((sig.coolantC - p.cool.lo) / (p.cool.hi - p.cool.lo), 0, 1) * p.cool.w - 1.5 } : { visible: false };
        const ty = Array.isArray(sig.tyres) && sig.tyres.length === 4 && sig.tyres.every((x) => x && ok(x.bar)) ? sig.tyres : null;
        out.tyresWord = { text: !ty ? '--' : ty.some((x) => x.bar < p.tyreLowBar) ? 'LOW' : 'OK', color: ty && ty.some((x) => x.bar < p.tyreLowBar) ? C.amber : C.ink };
        out.tyrePsi = { text: ty ? ty.map((x) => Math.round(x.bar * PSI)).join('·') + ' psi' : '-- psi' };
        out.hvText = { text: num(sig.socPct) };
        out.hv = { lit: ok(sig.socPct) ? Math.round(sig.socPct / 100 * 24) : 0 };
        out.evRangeText = { text: num(sig.evRangeKm, MPH) };
        const charging = ok(ele) && ele < -0.5;
        out.hvState = { text: !ok(ele) && !ok(sig.rpm) ? '--' : charging ? 'CHARGING' : engineOff ? 'ELECTRIC' : 'HYBRID',
            color: charging || engineOff ? C.blue : C.ink3 };
        out.tripText = { text: ok(sig.tripKm) ? (sig.tripKm * MPH).toFixed(1) : '--' };
        out.avgText = { text: 'AVG ' + num(sig.avgKmh, MPH) + ' MPH' };
        const clock = typeof sig.clock === 'string' && /^\d{1,2}:\d\d$/.test(sig.clock) ? sig.clock : '--:--';
        const oc = ok(sig.outsideC) ? (Math.round(sig.outsideC) < 0 ? MINUS : '') + Math.abs(Math.round(sig.outsideC)) : '--';
        out.topText = { text: clock + '    ' + oc };
        return out;
    },
};
