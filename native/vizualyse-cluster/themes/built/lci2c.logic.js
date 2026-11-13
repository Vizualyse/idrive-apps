// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// LCI inspired 2 · Comfort: the Sport lens and bands, calm: speed on the left
// band with the cruise set speed marked, revs in pale grey, the speed limit
// and cruise above the speed box, D + gear with an EV lamp, the next turn,
// distance to go and arrival over a centre-zero CHARGE / ECO / POWER meter,
// an empty map panel, battery, e-range, economy, average speed, fuel,
// coolant and tyres. Nothing flashes. UK units: mph, miles, psi, deg C, mpg.
// A reading the source does not give shows "--".
'use strict';
const MPH = 0.621371, PSI = 14.5038, MI = 0.621371, MPG = 282.481;

const ok = (v) => v != null && isFinite(v);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        st.kmh = st.kmh || new core.Spring(10);
        st.rpm = st.rpm || new core.Spring(8);
        const kmh = st.kmh.step(sig.kmh, ctx.dt), rpm = st.rpm.step(sig.rpm, ctx.dt);
        const out = {};

        /* the bands */
        const mph = ok(kmh) ? kmh * MPH : null;
        out.speed = ok(mph) ? { visible: true, value: core.scale(mph, p.speedMap) } : { visible: false };
        out.spd = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        out.tach = ok(rpm) ? { visible: true, value: core.scale(rpm, p.tachMap) } : { visible: false };

        /* limit and cruise: the set speed in green and marked on the band; off "– –" */
        out.limit = { text: ok(sig.limitKmh) ? String(Math.round(sig.limitKmh * MPH / 5) * 5) : '--' };
        if (ok(sig.cruiseKmh)) {
            const set = Math.round(sig.cruiseKmh * MPH);
            out.setV = { text: String(set), color: C.ok };
            out.setMark = { visible: true, value: core.scale(set, p.speedMap) };
        } else {
            out.setV = { text: '– –', color: C.ink3 };
            out.setMark = { visible: false };
        }
        out.trip = { text: ok(sig.tripKm) ? (sig.tripKm * MI).toFixed(1) : '--' };

        /* D + gear; the EV lamp when the engine is off and the motor drives */
        const g = sig.gear;
        out.gear = { text: !ok(g) ? '-' : g === 0 ? 'N' : String(g) };
        out.modeMask = { visible: sig.gearMode !== 'D' };
        const ev = (ok(sig.rpm) && sig.rpm < 100) || (ok(sig.engineHp) && sig.engineHp <= 0 && ok(sig.elecHp) && sig.elecHp > 0);
        out.evTag = { visible: !!ev, text: 'EV' };

        /* guidance: the next turn (arrow, distance in miles, yards under a quarter mile, road), to go, arrival */
        out.arrow = sig.turnDir === 'left' || sig.turnDir === 'right'
            ? { visible: true, uniforms: { u_pool: [0, 0, 0, sig.turnDir === 'left' ? 1 : 0] } } : { visible: false };
        let tv = '--', tu = '';
        if (ok(sig.turnM)) {
            const mi = sig.turnM / 1609.344;
            if (mi >= 0.25) { tv = mi.toFixed(1); tu = 'mi'; } else { tv = String(Math.max(50, Math.round(sig.turnM * 1.0936 / 50) * 50)); tu = 'yd'; }
        }
        const tw = tv.split('').reduce((n, c) => n + (p.turn.adv[c] || p.turn.adv.d), 0);
        out.turnV = { text: tv };
        out.turnU = { text: tu, x: Math.round(p.turn.x + tw + p.turn.gap) };
        out.road = { text: sig.road ? String(sig.road).toUpperCase().slice(0, 16) : '--' };
        out.togo = { text: ok(sig.destKm) ? (sig.destKm * MI).toFixed(1) : '--' };
        out.eta = { text: sig.eta ? String(sig.eta) : '--:--' };

        /* the meter: drive right of zero (engine pale, then electric), regen a hatch left of it */
        const eng = sig.engineHp, el = sig.elecHp;
        const px = (hp) => Math.round(clamp(hp / p.maxHp, 0, 1) * p.pos);
        const ew = ok(eng) ? px(Math.max(0, eng)) : 0;
        const lw = ok(el) && el > 0 ? Math.min(px(el), p.pos - ew) : 0;
        out.meterPos = { lit: ew + lw, uniforms: { u_split: [ew, 9999, 0, 0] } };
        const rgPx = ok(el) && el < 0 ? clamp(-el / p.negHp, 0, 1) * p.neg : 0;
        const cells = Math.round(rgPx / 5.9);
        out.meterNeg = { lit: cells, x: Math.round(p.zero - 12 - cells * 5.9) };
        const zone = rgPx > 2 ? 'CHARGE' : ew + lw > p.ecoEnd ? 'POWER' : 'ECO';
        out.zone = ok(eng) || ok(el) ? { visible: true, text: zone, x: p.zones[zone] } : { visible: false };

        /* fuel and range; coolant; tyres as one line (the pair's mean) */
        const fuel = sig.fuelPct;
        out.fuelPct = { text: num(fuel) + ' %' };
        out.fuelSegs = { lit: ok(fuel) ? clamp(Math.round(fuel / 10), 0, 10) : 0, uniforms: { u_c0: ok(fuel) && fuel < 15 ? C.warm : C.ink2 } };
        out.range = { text: num(sig.rangeKm, MI) };
        out.cool = { text: num(sig.coolantC) + ' °C' };
        out.coolBar = { lit: ok(sig.coolantC) ? Math.round(clamp((sig.coolantC - 50) / 80, 0, 1) * 168) : 0 };
        const ty = (i) => (sig.tyres && sig.tyres[i] && sig.tyres[i].bar);
        const pairPsi = (a, b) => (ok(ty(a)) && ok(ty(b)) ? String(Math.round((ty(a) + ty(b)) / 2 * PSI)) : '--');
        out.tyres = { text: 'F ' + pairPsi(0, 1) + ' · R ' + pairPsi(2, 3) };

        /* the bottom row */
        out.soc = { text: num(sig.socPct) };
        out.socBar = { lit: ok(sig.socPct) ? Math.round(36 * clamp(sig.socPct, 0, 100) / 100) : 0 };
        out.erange = { text: num(sig.evRangeKm, MI) };
        out.mpg = { text: ok(sig.avgL100) && sig.avgL100 > 0 ? Math.min(999, MPG / sig.avgL100).toFixed(1) : '--' };
        out.avg = { text: num(sig.avgKmh, MPH) };

        /* outside the lens */
        out.clock = { text: sig.clock ? String(sig.clock) : '--:--' };
        const oc = ok(sig.outsideC) ? Math.round(sig.outsideC) : null;
        out.otemp = { text: (oc == null ? '--' : (oc < 0 ? '−' : '') + Math.abs(oc)) + ' °C' };
        out.odo = { text: ok(sig.odoKm) ? String(Math.floor(sig.odoKm * MI)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' mi' : '-- mi' };
        return out;
    },
};
