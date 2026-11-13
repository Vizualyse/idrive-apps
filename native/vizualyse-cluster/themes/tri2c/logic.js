// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// Three-dial 2 (the tri2 family): a big rev counter whose grooved track lights
// with the revs, the gear and the speed in it, a lime shift ladder closing in
// on the top centre; a power dial (engine white, electric teal, regen teal
// below zero); a pit board of four tyre slats; fuel and battery columns on the
// left, oil and coolant on the right. UK units: mph, miles, psi, deg C.
// A reading the source does not give shows "--", never a made-up number.
'use strict';
const MPH = 0.621371, PSI = 14.504;

const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const signed = (v) => (v < 0 ? '−' : '') + Math.abs(v);
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* Text laid out here, part by part (each part anchored at its own screen x):
 * the text shader's glyph codes and left edges, from the font's advances. */
function place(p, name, parts) {
    const L = p.lay[name], F = p.fonts[L.font];
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    const codes = [], pos = [];
    parts.forEach((q) => {
        const s = String(q.s);
        const cs = s.split('').map((c) => { const i = F.glyphs.indexOf(c); return i < 0 ? blank : i; });
        const w = cs.reduce((n, c) => n + F.adv[c], 0);
        let x = (q.align === 'right' ? q.x - w : q.align === 'center' ? q.x - w / 2 : q.x) - L.x;
        cs.forEach((c) => { if (codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += F.adv[c]; });
    });
    /* ascending left edges: the shader takes the last glyph whose edge a pixel has passed */
    for (let i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i], pos[i - 1]);
    const n = codes.length;
    for (let i = n; i < 16; i++) { codes.push(blank); pos.push(100000); }
    return { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, F.glyphs.length, F.cellW, n] } };
}

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core, t = ctx.t || 0;
        st.kmh = st.kmh || new core.Spring(12);
        st.rpm = st.rpm || new core.Spring(18);
        st.eng = st.eng || new core.Spring(10);
        st.ele = st.ele || new core.Spring(10);
        const kmh = st.kmh.step(sig.kmh, ctx.dt), rpm = st.rpm.step(sig.rpm, ctx.dt);
        const eng = st.eng.step(sig.engineHp, ctx.dt), ele = st.ele.step(sig.elecHp, ctx.dt);
        const out = {};
        const T = p.tach, comfort = p.mode === 'comfort';

        /* revs: the grooves dimmed past the needle (all dimmed, no needle, without a reading) */
        out.tach = ok(rpm)
            ? { value: clamp(rpm / T.max, 0, 1), needle: comfort ? C.z9 : rpm >= T.red ? C.signal : C.z10 }
            : { value: 0, needle: C.none };

        if (!comfort) sport(sig, ctx, out, kmh, rpm);
        else comfortCentre(sig, ctx, out, kmh, rpm);

        /* power: engine from zero (Sport white, Comfort grey), electric teal after it; regen teal below zero */
        const W = p.power;
        const pA = (hp) => W.a0 + (W.a1 - W.a0) * (clamp(hp, W.lo, W.hi) - W.lo) / (W.hi - W.lo);
        const tP = (hp) => clamp((((W.start - pA(hp)) % 360) + 360) % 360 / W.span, 0, 1);
        const e = ok(eng) ? Math.max(0, eng) : 0, el = ok(ele) ? ele : 0;
        if (el < -0.5) {
            out.pwDim = { value: tP(el), uniforms: { u_seg: [0, 0, 1, 1] } };
            out.pwTint = { value: 0, glow: [0, 0, 0, 0], uniforms: { u_seg: [0, 0, 0, 1] } };
        } else {
            const tot = e + Math.max(0, el);
            out.pwDim = { value: tot > 0.5 ? tP(tot) : 1, uniforms: { u_seg: [0, 0, 0, 1] } };
            out.pwTint = el >= 1 ? { value: tP(e), glow: p.tint, uniforms: { u_seg: [0, 0, tP(tot), 1] } }
                : { value: 0, glow: [0, 0, 0, 0], uniforms: { u_seg: [0, 0, 0, 1] } };
        }
        /* Comfort's needle marks the total (the dimmed stretch ends there); none without the readings */
        if (comfort) out.pwDim.needle = ok(eng) && ok(ele) ? C.z10 : C.none;
        if (!comfort) {
            out.pTotal = { text: ok(eng) && ok(ele) ? signed(Math.round(e + ele)) : '--' };
            out.pEng = { text: ok(eng) ? String(Math.round(e)) : '--' };
            out.pEle = { text: ok(ele) ? signed(Math.round(ele) === 0 ? 0 : Math.round(ele)) : '--' };
            out.pEleLbl = { text: el < -0.5 ? 'Recovering' : 'Electric' };
        } else comfortLeft(sig, ctx, out, ok(eng) && ok(ele) ? e + el : null);

        columns(sig, ctx, out);
        if (!comfort) tyres(sig, ctx, out);
        else comfortRight(sig, ctx, out);

        /* the line under the dial: clock · outside · odometer */
        const oc = ok(sig.outsideC) ? Math.round(sig.outsideC) : null;
        out.metaA = { text: (sig.clock || '--') + ' · ' + (oc == null ? '--' : signed(oc)) + ' °C' };
        out.metaB = { text: ' · ' + (ok(sig.odoKm) ? thousands(Math.floor(sig.odoKm * MPH)) : '--') + ' mi' };
        return out;
    },
};

/* Sport's centre: the shift ladder, the gear, the speed */
function sport(sig, ctx, out, kmh, rpm) {
        const p = ctx.params, C = p.colors, st = ctx.state, t = ctx.t || 0;
        /* the shift ladder: pairs from the outer ends in, all flashing from the due point (2.5 Hz) */
        const Ld = p.ladder;
        const pulling = ok(rpm) && (!ok(sig.throttle) || sig.throttle > 0.3);
        const due = pulling && rpm >= Ld.due;
        let lit = 0;
        if (pulling) for (let i = 0; i < Ld.n; i++) if (rpm >= Ld.from + i * Ld.step) lit = i + 1;
        if (due) lit = Math.floor(t * 5) % 2 === 0 ? Ld.n : 0;
        out.ladderL = out.ladderR = { value: clamp(lit * Ld.cell, 0, 1) };

        /* gear: lime with the cue; drops into place on a change */
        const g = sig.gear;
        const gt = !ok(g) ? '--' : g === 0 ? 'N' : g < 0 ? 'R' : String(g);
        if (st.gear !== gt) { st.slotAt = st.gear == null ? -1 : t; st.gear = gt; }
        const slot = t - st.slotAt < 0.09 && t >= st.slotAt;
        const gc = due ? C.shift : C.z10;
        out.gear = { text: gt, color: slot ? [gc[0], gc[1], gc[2], 0.5] : gc, y: p.gearY + (slot ? 11 : 0) };
        out.gmMask = { visible: sig.gearMode !== p.modeLetter };
        out.speed = { text: num(kmh, MPH) };
}

/* columns: fuel from its level down, the battery up to its level (one band);
 * coolant and oil, the mirror image. Sport leads with the percentage, Comfort with the range */
function columns(sig, ctx, out) {
        const p = ctx.params;
        const K = p.cols;
        const top = (f) => (ok(f) ? (1 - clamp(f, 0, 1)) * K.t1 : K.t1);
        const up = (f) => (ok(f) ? K.t2 + clamp(f, 0, 1) * (1 - K.t2) : K.t2);
        const tN = (c) => (ok(c) ? (c - p.tempFrom) / (p.tempTo - p.tempFrom) : null);
        out.stores = { value: up(ok(sig.socPct) ? sig.socPct / 100 : null), uniforms: { u_seg: [0, 0, top(ok(sig.fuelPct) ? sig.fuelPct / 100 : null), 1] } };
        out.temps = { value: up(tN(sig.oilC)), uniforms: { u_seg: [0, 0, top(tN(sig.coolantC)), 1] } };
        const X = p.colX;
        const pct = (v) => (ok(v) ? Math.round(v) + ' %' : '--');
        const deg = (v) => (ok(v) ? Math.round(v) + ' °C' : '--');
        const mi = (v) => (ok(v) ? Math.round(v * MPH) + ' mi' : '--');
        const state = (c, hot) => (!ok(c) ? '' : c < 80 ? 'Warming' : c > hot ? 'Hot' : 'Normal');
        if (p.mode === 'comfort') {
            /* "315 mi": the figure and its small unit centred together */
            const r = (v) => (ok(v) ? String(Math.round(v * MPH)) : '--');
            const L = line(p, ['storeVal', 'storeUnit'], [[{ s: r(sig.rangeKm), l: 0 }, { s: ' mi', l: 1 }], [{ s: r(sig.evRangeKm), l: 0 }, { s: ' mi', l: 1 }]], [X.fuel, X.batt]);
            out.storeVal = L.storeVal; out.storeUnit = L.storeUnit;
            out.storeSub = place(p, 'storeSub', [{ s: pct(sig.fuelPct), x: X.fuel, align: 'center' }, { s: pct(sig.socPct), x: X.batt, align: 'center' }]);
        } else {
            out.storeVal = place(p, 'storeVal', [{ s: pct(sig.fuelPct), x: X.fuel, align: 'center' }, { s: pct(sig.socPct), x: X.batt, align: 'center' }]);
            out.storeSub = place(p, 'storeSub', [{ s: mi(sig.rangeKm), x: X.fuel, align: 'center' }, { s: mi(sig.evRangeKm), x: X.batt, align: 'center' }]);
        }
        out.tempVal = place(p, 'tempVal', [{ s: deg(sig.oilC), x: X.oil, align: 'center' }, { s: deg(sig.coolantC), x: X.cool, align: 'center' }]);
        out.tempSub = place(p, 'tempSub', [{ s: state(sig.oilC, p.oilHot), x: X.oil, align: 'center' }, { s: state(sig.coolantC, p.coolHot), x: X.cool, align: 'center' }]);
}

/* Sport's right dial: the pit board */
function tyres(sig, ctx, out) {
        const p = ctx.params, C = p.colors, st = ctx.state;

        /* tyres: psi, temperature and its bar; LOW holds once seen (until the theme restarts), COLD under 60 deg C */
        const Y = p.tyres;
        st.low = st.low || [false, false, false, false];
        const flags = [];
        for (let i = 0; i < 4; i++) {
            const ty = (sig.tyres && sig.tyres[i]) || {};
            if (ok(ty.bar) && ty.bar < Y.target[i] - Y.low) st.low[i] = true;
            const low = st.low[i];
            const c = ty.c, s = !ok(c) ? 'none' : c < Y.cold ? 'cold' : c > Y.hot ? 'hot' : 'ok';
            out['psi' + i] = { text: num(ty.bar, PSI), color: low ? C.caution : C.z10 };
            out['temp' + i] = { text: ok(c) ? Math.round(c) + '°' : '--', color: s === 'hot' ? C.caution : s === 'cold' ? C.z7 : C.z9 };
            out['tyreBar' + i] = { lit: ok(c) ? Math.round(46 * clamp((c - 30) / 80, 0.04, 1)) : 0,
                uniforms: { u_c0: s === 'hot' ? C.caution : s === 'cold' ? C.z6 : C.z9 } };
            out['tyreRing' + i] = { visible: low };
            flags.push(low ? 'LOW' : s === 'cold' ? 'COLD' : '');
        }
        /* a row's flags share a colour: caution when either is LOW */
        [['flagF', 0], ['flagR', 2]].forEach(([k, i]) => {
            const r = Y.x[i] + 102, r2 = Y.x[i + 1] + 102;
            out[k] = Object.assign(place(p, k, [{ s: flags[i], x: r, align: 'right' }, { s: flags[i + 1], x: r2, align: 'right' }]),
                { color: flags[i] === 'LOW' || flags[i + 1] === 'LOW' ? C.caution : C.z6 });
        });
}

/* A line whose parts are in several text layers (each at most 16 glyphs, or in
 * different fonts), centred together at each anchor: groups[k] is a list of
 * { s, l } (the text and its layer's index in names), centred at anchors[k]. */
function line(p, names, groups, anchors) {
    const items = names.map(() => []);
    groups.forEach((g, k) => {
        const parts = g.map((q) => {
            const L = p.lay[names[q.l]], F = p.fonts[L.font], blank = Math.max(0, F.glyphs.indexOf(' '));
            const cs = String(q.s).split('').map((c) => { const j = F.glyphs.indexOf(c); return j < 0 ? blank : j; });
            return { l: q.l, cs, adv: F.adv, w: cs.reduce((n, c) => n + F.adv[c], 0) };
        });
        let x = anchors[k] - parts.reduce((n, q) => n + q.w, 0) / 2;
        parts.forEach((q) => q.cs.forEach((c) => { items[q.l].push([c, x]); x += q.adv[c]; }));
    });
    const out = {};
    names.forEach((n, j) => {
        const L = p.lay[n], F = p.fonts[L.font], blank = Math.max(0, F.glyphs.indexOf(' '));
        const it = items[j].slice(0, 16), codes = [], pos = [];
        it.forEach(([c, x]) => { codes.push(c); pos.push(Math.max(pos.length ? pos[pos.length - 1] : -1e5, Math.round(x - L.x))); });
        const cnt = codes.length;
        while (codes.length < 16) { codes.push(blank); pos.push(100000); }
        out[n] = { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, F.glyphs.length, F.cellW, cnt] } };
    });
    return out;
}

/* Comfort's centre: speed first (red over the limit), the set speed, the limit sign, D and the gear */
function comfortCentre(sig, ctx, out, kmh) {
    const p = ctx.params, C = p.colors;
    const lim = ok(sig.limitKmh) ? Math.round(sig.limitKmh * MPH) : null;
    const mph = ok(kmh) ? Math.round(kmh * MPH) : null;
    out.speed = { text: mph == null ? '--' : String(mph), color: mph != null && lim != null && mph > lim + 2 ? C.signal : C.z10 };
    out.limit = { text: lim == null ? '--' : String(lim) };
    /* cruise: null is off, shown as dim dashes */
    out.setV = ok(sig.cruiseKmh) ? { text: String(Math.round(sig.cruiseKmh * MPH)), color: C.eco } : { text: '--', color: C.z6 };
    const g = sig.gear;
    if (sig.rpm === 0) out.gearN = { text: 'EV', color: C.electric };
    else out.gearN = { text: !ok(g) ? '--' : g === 0 ? 'N' : String(g), color: C.z8 };
    out.gmMask = { visible: sig.gearMode !== p.modeLetter };
}

/* Comfort's left dial: the zone lit, average mpg, electric miles and the trip */
function comfortLeft(sig, ctx, out, total) {
    const p = ctx.params, C = p.colors, Z = p.zones, L = p.lay.zoneOn;
    if (total == null) out.zoneOn = { visible: false };
    else {
        const z = total < -2 ? ['CHARGE', Z.charge, C.electric] : total <= p.power.eco ? ['ECO', Z.eco, C.eco] : ['POWER', Z.power, C.z10];
        out.zoneOn = { visible: true, text: z[0], color: z[2], x: z[1][0] - L.w / 2, y: z[1][1] - p.zoneB };
    }
    out.mpg = { text: ok(sig.avgL100) && sig.avgL100 > 0 ? (282.481 / sig.avgL100).toFixed(1) : '--' };
    out.evMi = { text: ok(sig.evTripKm) ? (sig.evTripKm * MPH).toFixed(1) + ' mi' : '--' };
    out.trip = { text: ok(sig.tripKm) ? (sig.tripKm * MPH).toFixed(1) + ' mi' : '--' };
}

/* Comfort's right dial: the map area is the car's; the next turn, arrival, the four pressures */
function comfortRight(sig, ctx, out) {
    const p = ctx.params;
    const dir = sig.turnDir === 'left' || sig.turnDir === 'right' ? sig.turnDir : null;
    out.arrow = dir ? { visible: true, uniforms: { u_pool: [0, 0, 0, dir === 'left' ? 1 : 0] } } : { visible: false };
    let d = '--';
    if (ok(sig.turnM)) {
        const miles = sig.turnM / 1609.344;
        d = miles >= 0.5 ? miles.toFixed(1) + ' mi' : Math.max(50, Math.round(sig.turnM * 1.09361 / 50) * 50) + ' yd';
    }
    out.navDist = { text: d };
    out.road = { text: sig.road ? String(sig.road).slice(0, 16) : '--' };
    const eta = line(p, ['etaA', 'etaB'], [[{ s: 'Arrive ' + (sig.eta || '--'), l: 0 },
        { s: ' · ' + (ok(sig.destKm) ? Math.round(sig.destKm * MPH) : '--') + ' mi', l: 1 }]], [1444]);
    out.etaA = eta.etaA; out.etaB = eta.etaB;
    const psi = (i) => num(sig.tyres && sig.tyres[i] && sig.tyres[i].bar, PSI);
    const ty = line(p, ['tyresA', 'tyresB'], [[{ s: 'Tyres ' + psi(0) + ' · ' + psi(1), l: 0 },
        { s: ' · ' + psi(2) + ' · ' + psi(3) + ' psi', l: 1 }]], [1444]);
    out.tyresA = ty.tyresA; out.tyresB = ty.tyresB;
}
