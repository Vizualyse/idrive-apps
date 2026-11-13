// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// Performance 1 (Sport): two open-bottomed round dials with a short glowing
// needle and a red swept band, twelve shift lights and a rev counter whose
// centre floods red at the shift point, a power balance bar (engine red right
// of zero, electric blue stacked on it, regen blue left of zero), boost with
// its peak, HV battery, tyres on the car plan, fuel, range, oil, coolant.
// UK units: mph, miles, psi, deg C. A reading the source does not give shows
// "--". Several readings share a text layer (one font, colour and baseline):
// the logic lays their glyphs out itself, and each unit follows its number
// 8 px after the last digit, as the mockup's do.
'use strict';
const MPH = 0.621371, PSI = 14.5038;

const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, k) => a.map((v, i) => Math.round(lerp(v, b[i], clamp(k, 0, 1)) * 1000) / 1000);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const signed = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + -n : '0');

/* a text layer's glyphs from items { s, x (panel px), anchor: start|middle|end, track }:
 * the uniforms text.frag reads, and each item's width */
function row(p, name, items) {
    const L = p.lay[name], f = p.fonts[L.font];
    const blank = Math.max(0, f.g.indexOf(' '));
    const codes = [], pos = [], widths = [];
    items.forEach((it) => {
        const s = String(it.s);
        const cs = s.split('').map((c) => { const i = f.g.indexOf(c); return i < 0 ? blank : i; });
        const w = cs.reduce((a, c) => a + f.adv[c] + (it.track || 0), 0) - (cs.length ? it.track || 0 : 0);
        widths.push(w);
        let x = it.anchor === 'end' ? it.x - w : it.anchor === 'middle' ? it.x - w / 2 : it.x;
        x -= L.x;
        /* a space only moves on: no glyph spent on it */
        cs.forEach((c) => { if (c !== blank && codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += f.adv[c] + (it.track || 0); });
    });
    const n = codes.length;
    for (let i = n; i < 16; i++) { codes.push(blank); pos.push(100000); }
    return { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, f.g.length, f.cw, n] }, widths };
}

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        ['kmh', 'rpm', 'eng', 'ele', 'boost'].forEach((k, i) => { st[k] = st[k] || new core.Spring([12, 18, 10, 10, 10][i]); });
        const kmh = st.kmh.step(sig.kmh, ctx.dt), rpm = st.rpm.step(sig.rpm, ctx.dt);
        const eng = st.eng.step(sig.engineHp, ctx.dt), ele = st.ele.step(sig.elecHp, ctx.dt);
        const boost = st.boost.step(sig.boostBar, ctx.dt);
        const out = {};
        const D = p.dial;

        /* dials */
        const mph = ok(kmh) ? kmh * MPH : null;
        out.speedDial = ok(mph) ? { visible: true, value: lerp(D.t0, D.t1, clamp(mph / p.speedMax, 0, 1)) } : { visible: false };
        out.tachDial = ok(rpm) ? { visible: true, value: lerp(D.t0, D.t1, clamp(rpm / p.tachMax, 0, 1)) } : { visible: false };
        out.speed = { text: num(mph) };
        out.rpm = { text: ok(rpm) ? thousands(Math.round(rpm / 10) * 10) : '--' };

        /* shift: the lights fill from 4,600 rpm; at the shift point all twelve blink red (2.5 Hz),
         * the rev counter's centre floods red and the chevron turns white */
        const raw = sig.rpm;
        const cue = ok(raw) && raw >= p.shiftRpm;
        const blink = Math.floor(ctx.t * 5) % 2 === 0;
        const lit = ok(raw) ? Math.floor(clamp((raw - p.lightsFrom) / (p.shiftRpm - p.lightsFrom), 0, 1) * 12 + 0.001) : 0;
        out.lights = cue ? { lit: 12, flash: blink ? 1 : 2 } : { lit, flash: 0 };
        out.flood = { visible: cue };
        const pre = ok(raw) && raw >= p.preRpm && (sig.throttle == null || sig.throttle > 0.5);
        const chev = cue ? C.ink : [C.amber[0], C.amber[1], C.amber[2], 0.9];
        out.chevron = { lit: cue || pre ? 2 : 0, uniforms: { u_c0: chev, u_c1: chev } };

        /* gear: the mode letter and the numeral */
        const g = sig.gear;
        out.gear = { text: !ok(g) ? '-' : g === 0 ? 'N' : String(g) };
        out.gearMode = { text: 'MDS'.indexOf(sig.gearMode) >= 0 && sig.gearMode ? sig.gearMode : ' ', color: cue ? C.ink : C.ink2 };
        out.rpmUnit = { color: cue ? C.ink : C.ink2 };

        /* power balance */
        const Pw = p.power;
        const e = ok(eng) ? Math.round(eng) : null, el = ok(ele) ? Math.round(ele) : null;
        const pw = row(p, 'pw', [{ s: e == null ? '--' : String(e), x: 648, anchor: 'start' },
            { s: el == null ? '--' : signed(el), x: 1240, anchor: 'end' }]);
        out.pw = { uniforms: pw.uniforms };
        out.pwUnit = { uniforms: row(p, 'pwUnit', [{ s: 'hp', x: 648 + pw.widths[0] + 8 }]).uniforms };
        const tot = e == null || el == null ? null : e + el;
        out.sys = { text: tot == null ? '--' : tot < 0 ? '−' + -tot : String(tot) };
        const engPx = e == null ? 0 : clamp(e, 0, 400) * Pw.pxPerHp;
        out.engBar = { lit: Math.max(0, Math.round(Pw.zeroX + engPx - Pw.engX)) };
        if (el == null || el === 0) out.elBar = { lit: 0 };
        else if (el > 0) {
            const x = Math.round(Pw.zeroX + engPx);
            out.elBar = { x, lit: clamp(Math.round(Pw.zeroX + engPx + el * Pw.pxPerHp) - x, 0, Pw.x1 - x) };
        } else {
            const x = Math.round(Pw.zeroX - clamp(-el, 0, 100) * Pw.pxPerHp);
            out.elBar = { x, lit: Math.round(Pw.zeroX) - 1 - x };
        }

        /* boost (vacuum shows as 0.00) and the peak of the pull: kept until the next pull starts */
        const b = ok(boost) ? Math.max(0, boost) : null;
        if (b != null) {
            st.off = b <= 0.05 ? (st.off || 0) + ctx.dt : st.off || 0;
            if (b > 0.3 && st.off > 3) st.peak = 0;
            if (b > 0.05) st.off = 0;
            st.peak = Math.max(st.peak || 0, b);
        }
        out.boostBar = { lit: b == null ? 0 : Math.round(clamp(b / p.boostMax, 0, 1) * 160) };
        out.peakMark = b == null ? { visible: false } : { visible: true, x: 648 + clamp(st.peak / p.boostMax, 0, 1) * 160 - 1.5 };
        out.peak = { text: b == null ? '--' : st.peak.toFixed(2) };

        /* HV battery */
        const soc = sig.socPct;
        const n362 = row(p, 'n362', [{ s: b == null ? '--' : b.toFixed(2), x: 648 }, { s: num(soc), x: 1112 }]);
        out.n362 = { uniforms: n362.uniforms };
        out.u362 = { uniforms: row(p, 'u362', [{ s: 'bar', x: 648 + n362.widths[0] + 8 }, { s: '%', x: 1112 + n362.widths[1] + 8 }]).uniforms };
        out.hv = { lit: ok(soc) ? Math.round(soc / 10) : 0 };
        const state = el == null ? '' : el > 8 ? 'ASSISTING' : el < -4 ? 'CHARGING' : 'HOLDING';
        out.hvState = { uniforms: row(p, 'hvState', [{ s: state, x: 1112, track: 1.1 }]).uniforms,
            color: Math.abs(el || 0) > 8 || (el || 0) < -4 ? C.elec : C.ink3 };

        /* tyres FL FR RL RR: pressure (psi) over temperature, the block cold grey to warm white */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        const psi = (i) => num(ty(i).bar, PSI), tc = (i) => num(ty(i).c);
        out.psiF = { uniforms: row(p, 'psiF', [{ s: psi(0), x: 894, anchor: 'end' }, { s: psi(1), x: 1026 }]).uniforms };
        out.tempF = { uniforms: row(p, 'tempF', [{ s: tc(0), x: 894, anchor: 'end' }, { s: tc(1), x: 1026 }]).uniforms };
        out.tempR = { uniforms: row(p, 'tempR', [{ s: tc(2), x: 894, anchor: 'end' }, { s: tc(3), x: 1026 }]).uniforms };
        const warm = (i) => (ok(ty(i).c) ? mix(C.cool, C.warm, (ty(i).c - p.tyreCold) / (p.tyreWarm - p.tyreCold)) : C.cool);
        out.tyresF = { uniforms: { u_c0: warm(0), u_c1: warm(1) } };
        out.tyresR = { uniforms: { u_c0: warm(2), u_c1: warm(3) } };

        /* y 544: 12 V, rear pressures, electric range */
        const v12 = ok(sig.volts12) ? sig.volts12.toFixed(1) : '--';
        const n544 = row(p, 'n544', [{ s: v12, x: 648 }, { s: psi(2), x: 894, anchor: 'end' }, { s: psi(3), x: 1026 },
            { s: num(sig.evRangeKm, MPH), x: 1112 }]);
        out.n544 = { uniforms: n544.uniforms };
        out.u544 = { uniforms: row(p, 'u544', [{ s: 'V', x: 648 + n544.widths[0] + 8 }, { s: 'mi', x: 1112 + n544.widths[3] + 8 }]).uniforms };

        /* under the dials: fuel (litres of the tank), range | oil, coolant */
        const fuelL = ok(sig.fuelPct) ? String(Math.round(sig.fuelPct / 100 * p.tankL)) : '--';
        const nL = row(p, 'n542L', [{ s: fuelL, x: 170 }, { s: num(sig.rangeKm, MPH), x: 350 }]);
        const nR = row(p, 'n542R', [{ s: num(sig.oilC), x: 1430 }, { s: num(sig.coolantC), x: 1610 }]);
        out.n542L = { uniforms: nL.uniforms };
        out.n542R = { uniforms: nR.uniforms };
        out.u542 = { uniforms: row(p, 'u542', [{ s: 'L', x: 170 + nL.widths[0] + 8 }, { s: 'mi', x: 350 + nL.widths[1] + 8 },
            { s: '°C', x: 1430 + nR.widths[0] + 8 }, { s: '°C', x: 1610 + nR.widths[1] + 8 }]).uniforms };
        const frac = (v, r) => (ok(v) ? Math.round(clamp((v - r[0]) / (r[1] - r[0]), 0, 1) * 150) : 0);
        out.fuelBar = { lit: ok(sig.fuelPct) ? Math.round(clamp(sig.fuelPct / 100, 0, 1) * 150) : 0 };
        out.oilBar = { lit: frac(sig.oilC, p.oil) };
        out.coolBar = { lit: frac(sig.coolantC, p.cool) };

        /* status row */
        out.clock = { text: typeof sig.clock === 'string' && /^\d\d?:\d\d$/.test(sig.clock) ? sig.clock : '--:--' };
        const oc = ok(sig.outsideC) ? Math.round(sig.outsideC) : null;
        out.outside = { text: (oc == null ? '--' : oc < 0 ? '−' + -oc : String(oc)) + ' °C' };
        return out;
    },
};
