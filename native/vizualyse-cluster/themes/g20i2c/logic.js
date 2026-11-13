// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// G20 inspired 2 · Comfort: speed and revs along the chamfered frames with an
// amber wake and a pale pointer, the speed limit (sign, red tick on the scale,
// red digits over it) and the cruise set speed, the drive meter (CHARGE, ECO,
// POWER) and instantaneous economy on the power bars, D + the gear in use,
// the next manoeuvre under the car's own map, trip and average economy.
// Nothing flashes. UK units: mph, miles, yards, mpg, deg C. A reading the
// source does not give shows "--".
'use strict';
const MPH = 0.621371, MPG = 282.481;   /* UK mpg = 282.481 / (l/100 km) */

const ok = (v) => v != null && isFinite(v);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        st.kmh = st.kmh || new core.Spring(9);
        st.rpm = st.rpm || new core.Spring(10);
        st.pw = st.pw || new core.Spring(6);
        st.mpg = st.mpg || new core.Spring(4);
        const kmh = st.kmh.step(sig.kmh, ctx.dt), rpm = st.rpm.step(sig.rpm, ctx.dt);
        const out = {};

        /* speed and revs: pointer, amber wake, pool; the light fades in over the scale's first 60 px */
        const along = (f) => ({ visible: true, value: lerp(p.speedT0, 1, f),
            glow: [1, 0.66, 0.3, 0.42 * clamp(f * (1 - p.speedT0) * p.scaleLen / 60, 0, 1)] });
        const mph = ok(kmh) ? kmh * MPH : null;
        out.speed = ok(mph) ? along(core.scale(mph, p.speedMap)) : { visible: false };
        out.tach = ok(rpm) ? along(core.scale(rpm / 1000, p.tachMap)) : { visible: false };
        out.rpm = { text: ok(rpm) ? thousands(Math.round(rpm / 10) * 10) : '--' };

        /* the limit: the sign, its tick on the scale, the speed in red above it */
        const limit = ok(sig.limitKmh) ? Math.round(sig.limitKmh * MPH) : null;
        out.limit = { text: limit == null ? '--' : String(limit) };
        out.limitTick = limit == null ? { visible: false } : { visible: true, value: lerp(p.speedT0, 1, core.scale(limit, p.speedMap)) };
        const over = limit != null && ok(mph) && Math.round(mph) > limit + 1;
        out.kmh = { text: ok(mph) ? String(Math.round(mph)) : '--', color: over ? C.sport : C.ink };

        /* cruise: SET speed, and its mark outside the scale (off: "--", no mark) */
        const set = ok(sig.cruiseKmh) ? Math.round(sig.cruiseKmh * MPH) : null;
        out.set = { text: set == null ? '--' : String(set), color: set == null ? C.ink3 : C.ink };
        if (set != null) {
            const k = clamp(set, 0, 160) / p.setStep, i = Math.min(Math.floor(k), p.setPos.length - 2), f = k - i;
            const a = p.setPos[i], b = p.setPos[i + 1];
            out.setMark = { visible: true, x: lerp(a[0], b[0], f) - 5, y: lerp(a[1], b[1], f) - 5 };
        } else out.setMark = { visible: false };

        /* gear: the selector letter, the gear in use (or EV) beside it */
        const ev = sig.engineHp === 0 && ok(sig.elecHp) && sig.elecHp > 0;
        out.mode = { text: sig.gearMode ? String(sig.gearMode).slice(0, 1) : '-' };
        out.gearSub = { text: ev ? 'EV' : !ok(sig.gear) ? '--' : sig.gear === 0 ? 'N' : String(sig.gear) };

        /* drive meter: -25 % (charge) .. 100 %, ECO to 35 %; from its zero either way */
        const B = p.barT;
        if (ok(sig.engineHp) || ok(sig.elecHp)) {
            const hp = (sig.engineHp || 0) + (sig.elecHp || 0);
            const target = hp >= 0 ? hp / p.driveHp : 0.25 * hp / p.regenHp;
            const pw = clamp(st.pw.step(target, ctx.dt), -0.25, 1);
            const word = pw < -0.01 ? 'CHARGE' : pw > p.ecoMax ? 'POWER' : 'ECO';
            const col = word === 'CHARGE' ? C.regen : ev ? C.edrive : C.calm;
            out.drive = { visible: Math.abs(pw) > 0.004, value: lerp(B.eng0, B.eng1, clamp(p.pwrZero + pw * 0.8, 0, 1)), color: col };
            out.driveWord = { text: word, color: col };
        } else {
            out.drive = { visible: false };
            out.driveWord = { text: '--', color: C.ink3 };
        }

        /* economy: instantaneous mpg on 0..80, "99+" coasting or electric */
        if (ev || ok(sig.instL100)) {
            const raw = ev || sig.instL100 <= 0.01 ? 99 : MPG / sig.instL100;
            const m = st.mpg.step(Math.min(99, raw), ctx.dt);
            out.econ = { visible: true, value: lerp(B.eleBottom, B.eleTop, ev ? 1 : clamp(m / p.mpgMax, 0, 1)), color: ev ? C.edrive : C.ink2 };
            out.mpg = { text: ev || m >= 98 ? '99+' : String(Math.round(m)) };
        } else {
            out.econ = { visible: false };
            out.mpg = { text: '--' };
        }

        /* HV battery: electric range in miles, charge below it */
        out.soc = { lit: ok(sig.socPct) ? Math.round(sig.socPct / 5) : 0 };
        out.evMi = { text: num(sig.evRangeKm, MPH) + ' mi' };
        out.socPct = { text: num(sig.socPct) + ' %' };

        /* fuel and range */
        out.fuel = ok(sig.fuelPct) ? { visible: true, value: clamp(sig.fuelPct / 100, 0, 1) } : { visible: false };
        out.range = { text: num(sig.rangeKm, MPH) + ' mi' };

        /* oil */
        if (ok(sig.oilC)) {
            const o = p.oil, a = lerp(o.a0, o.a1, clamp((sig.oilC - o.from) / (o.to - o.from), 0, 1)) * Math.PI / 180;
            out.oilMark = { visible: true, x: o.cx + o.r * Math.cos(a) - 10, y: o.cy + o.r * Math.sin(a) - 3.5 };
        } else out.oilMark = { visible: false };
        out.oilC = { text: num(sig.oilC) + ' °C' };

        /* the next manoeuvre: arrow, distance (yards under half a mile), road; arrival */
        out.arrowR = { visible: sig.turnDir === 'right' };
        out.arrowL = { visible: sig.turnDir === 'left' };
        let gd = '--';
        if (ok(sig.turnM)) {
            const miles = sig.turnM / 1609.344;
            gd = miles >= 0.5 ? miles.toFixed(1) + ' mi' : Math.max(50, Math.round(sig.turnM * 1.09361 / 50) * 50) + ' yd';
        }
        out.guideDist = { text: gd };
        out.road = { text: sig.road ? String(sig.road).slice(0, 16) : '--' };
        out.eta = { text: (sig.eta ? String(sig.eta).slice(0, 5) : '--:--') + ' · ' + (ok(sig.destKm) ? (sig.destKm * MPH).toFixed(1) : '--') + ' mi' };

        /* status row */
        out.clock = { text: sig.clock ? String(sig.clock).slice(0, 5) : '--:--' };
        out.trip = { text: 'TRIP ' + (ok(sig.tripKm) ? (sig.tripKm * MPH).toFixed(1) : '--') + ' mi' };
        out.avg = { text: '· ' + (ok(sig.avgL100) && sig.avgL100 > 0 ? String(Math.round(MPG / sig.avgL100)) : '--') + ' mpg' };
        out.outside = { text: (ok(sig.outsideC) ? (sig.outsideC >= 0 ? '+' : '−') + Math.abs(sig.outsideC).toFixed(1) : '--') + ' °C' };
        return out;
    },
};
