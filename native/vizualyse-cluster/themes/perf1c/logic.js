// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// Performance 1 · Comfort: the perf1 family's calm theme. The same two dials
// in Calm (the rev counter dimmed) with a white needle; the speed limit and
// cruise in the speedometer; D and the gear, an EV light while the engine is
// off; guidance (turn arrow, distance, road) in the top row; the range split
// over the drive meter; economy, HV battery and arrival; fuel, trip, coolant,
// tyres. UK units: mph, miles, mpg, psi, deg C. A reading the source does not
// give shows "--"; cruise off (null) hides the cruise speed and its pointer.
// Several readings share a text layer: the logic lays their glyphs out
// itself, units 8 px after the number, as the mockup's do.
'use strict';
const MPH = 0.621371, PSI = 14.5038, MPG = 282.481;

const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function widthOf(f, s, track) {
    const blank = Math.max(0, f.g.indexOf(' '));
    return String(s).split('').reduce((a, c) => { const i = f.g.indexOf(c); return a + f.adv[i < 0 ? blank : i] + (track || 0); }, 0) - (s.length ? track || 0 : 0);
}
/* a text layer's glyphs from items { s, x (panel px), anchor: start|middle|end, track }:
 * the uniforms text.frag reads, and each item's width; a space only moves on */
function row(p, name, items) {
    const L = p.lay[name], f = p.fonts[L.font];
    const blank = Math.max(0, f.g.indexOf(' '));
    const codes = [], pos = [], widths = [];
    items.forEach((it) => {
        const s = String(it.s);
        const cs = s.split('').map((c) => { const i = f.g.indexOf(c); return i < 0 ? blank : i; });
        const w = widthOf(f, s, it.track);
        widths.push(w);
        let x = it.anchor === 'end' ? it.x - w : it.anchor === 'middle' ? it.x - w / 2 : it.x;
        x -= L.x;
        cs.forEach((c) => { if (c !== blank && codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += f.adv[c] + (it.track || 0); });
    });
    const n = codes.length;
    for (let i = n; i < 16; i++) { codes.push(blank); pos.push(100000); }
    return { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, f.g.length, f.cw, n] }, widths };
}

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        ['kmh', 'rpm', 'eng', 'ele'].forEach((k, i) => { st[k] = st[k] || new core.Spring([12, 14, 8, 8][i]); });
        const kmh = st.kmh.step(sig.kmh, ctx.dt), rpm = st.rpm.step(sig.rpm, ctx.dt);
        const eng = st.eng.step(sig.engineHp, ctx.dt), ele = st.ele.step(sig.elecHp, ctx.dt);
        const out = {}, D = p.dial, u20 = p.fonts.u20;
        const onDial = (mph) => lerp(D.t0, D.t1, clamp(mph / p.speedMax, 0, 1));

        /* speedometer: speed, the limit sign, cruise (null: off) */
        const mph = ok(kmh) ? kmh * MPH : null;
        out.speedDial = ok(mph) ? { visible: true, value: onDial(mph) } : { visible: false };
        out.speed = { text: num(mph) };
        out.limit = { text: num(sig.limitKmh, MPH) };
        const cruise = ok(sig.cruiseKmh) ? sig.cruiseKmh * MPH : null;
        out.cruisePtr = cruise == null ? { visible: false } : { visible: true, value: onDial(cruise) };
        out.cruiseLab = cruise == null ? { visible: false } : { visible: true, uniforms: row(p, 'cruiseLab', [{ s: 'CRUISE', x: 322, anchor: 'end', track: 1.1 }]).uniforms };
        out.cruiseSet = cruise == null ? { visible: false } : { visible: true, text: String(Math.round(cruise)) };

        /* rev counter: the EV light while the engine is off (the rpm line hidden), D and the gear */
        const evLamp = ok(sig.rpm) && sig.rpm < p.evRpm;
        out.tachDial = ok(rpm) ? { visible: true, value: lerp(D.t0, D.t1, clamp(rpm / p.tachMax, 0, 1)) } : { visible: false };
        out.ev = { visible: evLamp, uniforms: row(p, 'ev', [{ s: 'EV', x: 1590, anchor: 'middle', track: 2 }]).uniforms };
        out.rpm = { visible: !evLamp, text: ok(rpm) ? thousands(Math.round(rpm / 10) * 10) : '--' };
        out.rpmUnit = { visible: !evLamp };
        out.gearMode = { text: typeof sig.gearMode === 'string' && 'DMSPRN'.indexOf(sig.gearMode) >= 0 && sig.gearMode ? sig.gearMode : '-' };
        const g = sig.gear;
        out.gear = { text: !ok(g) ? '-' : g === 0 ? ' ' : String(g) };

        /* range split: fuel | total | electric, in miles */
        const fr = ok(sig.rangeKm) ? Math.round(sig.rangeKm * MPH) : null, er = ok(sig.evRangeKm) ? Math.round(sig.evRangeKm * MPH) : null;
        const rr = row(p, 'ranges', [{ s: fr == null ? '--' : fr, x: 648 }, { s: er == null ? '--' : er, x: 1238, anchor: 'end' }]);
        out.ranges = { uniforms: rr.uniforms };
        out.rangeUnit = { uniforms: row(p, 'rangeUnit', [{ s: 'mi', x: 648 + rr.widths[0] + 8 }]).uniforms };
        out.range = { text: fr == null || er == null ? '--' : String(fr + er) };

        /* the drive meter: engine right of zero, electric stacked on it, regen left of zero */
        const Pw = p.power;
        const e = ok(eng) ? eng : null, el = ok(ele) ? ele : null;
        const engPx = e == null ? 0 : clamp(e, 0, Pw.max) * Pw.pxPerHp;
        out.engBar = { lit: Math.max(0, Math.round(Pw.zeroX + engPx - Pw.engX)) };
        if (el == null || Math.abs(el) < 0.5) out.elBar = { lit: 0 };
        else if (el > 0) {
            const x = Math.round(Pw.zeroX + engPx);
            out.elBar = { x, lit: clamp(Math.round(Pw.zeroX + engPx + el * Pw.pxPerHp) - x, 0, Pw.x1 - x) };
        } else {
            const x = Math.round(Pw.zeroX - clamp(-el, 0, -Pw.min) * Pw.pxPerHp);
            out.elBar = { x, lit: Math.round(Pw.zeroX) - 1 - x };
        }

        /* economy: the average (mpg, its marker on the bar) and now (the bar; EV while no fuel burns) */
        const avg = ok(sig.avgL100) && sig.avgL100 > 0 ? MPG / sig.avgL100 : null;
        const burning = ok(sig.instL100) && sig.instL100 > 0 && !(ok(e) && e <= 1);
        const nowMpg = burning ? Math.min(99, MPG / sig.instL100) : null;
        const soc = sig.socPct;
        const n362 = row(p, 'n362', [{ s: avg == null ? '--' : avg.toFixed(1), x: 648 }, { s: num(soc), x: 1112 }]);
        out.n362 = { uniforms: n362.uniforms };
        out.u362 = { uniforms: row(p, 'u362', [{ s: 'mpg', x: 648 + n362.widths[0] + 8 }, { s: '%', x: 1112 + n362.widths[1] + 8 }]).uniforms };
        out.avgMark = avg == null ? { visible: false } : { visible: true, x: 648 + clamp(avg / 100, 0, 1) * 160 - 1.5 };
        out.nowBar = { lit: nowMpg == null ? 0 : Math.round(clamp(nowMpg / 100, 0, 1) * 160) };
        out.now = !ok(sig.instL100) ? { text: '--', color: C.ink } : burning ? { text: String(Math.round(nowMpg)), color: C.ink } : { text: 'EV', color: C.elec };

        /* HV battery */
        out.hv = { lit: ok(soc) ? Math.round(soc / 10) : 0 };
        const evDrive = ok(e) && e <= 1;
        const state = el == null ? '' : el > 3 ? (evDrive ? 'ELECTRIC DRIVE' : 'ASSISTING') : el < -2 ? 'CHARGING' : 'HOLDING';
        out.hvState = { uniforms: row(p, 'hvState', [{ s: state, x: 1112, track: 1.1 }]).uniforms, color: el != null && (el > 3 || el < -2) ? C.elec : C.ink3 };

        /* y 544: electric trip, arrival; miles to go */
        const n544 = row(p, 'n544', [{ s: ok(sig.evTripKm) ? (sig.evTripKm * MPH).toFixed(1) : '--', x: 648 },
            { s: typeof sig.eta === 'string' && /^\d\d?:\d\d$/.test(sig.eta) ? sig.eta : '--:--', x: 1112 }]);
        out.n544 = { uniforms: n544.uniforms };
        out.u544 = { uniforms: row(p, 'u544', [{ s: 'mi', x: 648 + n544.widths[0] + 8 }]).uniforms };
        out.toGo = { uniforms: row(p, 'toGo', [{ s: num(sig.destKm, MPH) + ' mi to go', x: 1112 }]).uniforms };

        /* y 596: "Average 41 mph" ("Average" is art) and "35 35 / 38 38 psi" ("/" and "psi" are art) */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        const avgX = 350 + widthOf(u20, 'Average ');
        const avgS = num(sig.avgKmh, MPH);
        const slot = (i) => 1610 + widthOf(u20, '35 35 / 38 38 '.slice(0, [0, 3, 8, 11][i]));
        out.sub596 = { uniforms: row(p, 'sub596', [{ s: avgS + ' mph', x: avgX }].concat([0, 1, 2, 3].map((i) => ({ s: num(ty(i).bar, PSI), x: slot(i) })))).uniforms };

        /* under the dials: fuel (litres of the tank), trip | coolant, tyres' status */
        const fuelL = ok(sig.fuelPct) ? String(Math.round(sig.fuelPct / 100 * p.tankL)) : '--';
        const n542 = row(p, 'n542', [{ s: fuelL, x: 170 }, { s: ok(sig.tripKm) ? (sig.tripKm * MPH).toFixed(1) : '--', x: 350 }]);
        out.n542 = { uniforms: n542.uniforms };
        const cool = num(sig.coolantC);
        out.coolant = { text: cool };
        const coolW = widthOf(p.fonts.r36, cool);
        out.u542 = { uniforms: row(p, 'u542', [{ s: 'L', x: 170 + n542.widths[0] + 8 }, { s: 'mi', x: 350 + n542.widths[1] + 8 },
            { s: '°C', x: 1430 + coolW + 8 }]).uniforms };
        out.fuelBar = { lit: ok(sig.fuelPct) ? Math.round(clamp(sig.fuelPct / 100, 0, 1) * 150) : 0 };
        out.coolBar = { lit: ok(sig.coolantC) ? Math.round(clamp((sig.coolantC - p.cool[0]) / (p.cool[1] - p.cool[0]), 0, 1) * 150) : 0 };
        const bars = [0, 1, 2, 3].map((i) => ty(i).bar);
        out.tyreStatus = { text: bars.every(ok) ? (bars.some((b) => b < p.tyreLowBar) ? 'LOW' : 'OK') : '--' };

        /* top row: time, outside, guidance */
        out.clock = { text: typeof sig.clock === 'string' && /^\d\d?:\d\d$/.test(sig.clock) ? sig.clock : '--:--' };
        const oc = ok(sig.outsideC) ? Math.round(sig.outsideC) : null;
        out.outside = { text: (oc == null ? '--' : oc < 0 ? '−' + -oc : String(oc)) + ' °C' };
        /* the arrow is drawn turning right; mirrored, it turns left */
        out.arrow = sig.turnDir === 'right' || sig.turnDir === 'left'
            ? { visible: true, uniforms: { u_pool: [0, 0, 0, sig.turnDir === 'left' ? 1 : 0] } } : { visible: false };
        const m = sig.turnM;
        out.gDist = { text: !ok(m) ? '--' : m / 1609.34 >= 0.2 ? (m / 1609.34).toFixed(1) + ' mi' : Math.max(50, Math.round(m * 1.09361 / 50) * 50) + ' yd' };
        const road = typeof sig.road === 'string' && sig.road ? sig.road : '--';
        out.road = { uniforms: row(p, 'road', [{ s: road, x: 956 }]).uniforms };
        return out;
    },
};
