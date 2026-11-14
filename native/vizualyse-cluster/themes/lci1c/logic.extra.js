// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// lci1c: what the design's attributes can't say.
//  - The meter: one row of lights from the zero tick, left for charge (in
//    stripes), right through eco (to 0.6) and on into power; its zone named
//    in white.
//  - Several readings share one text layer (average and on electric; the
//    arrival line; range and fluids; the percentages; the trip and the four
//    tyres), and units follow their readings
//    (on electric, cruise, the turn's distance): laid out here at their
//    screen x with the font's advances (ctx.fonts), as the hand port did.
//    Before the theme is built (ctx.fonts empty) the bindings' text stands.
// UK units (mph, miles, mpg, yards); a reading the car does not give shows "--".
'use strict';
const KM_MI = 1.609344, PSI = 14.5038, YD = 1.09361;
const NONE = [0, 0, 0, 0];
const fin = (v) => typeof v === 'number' && isFinite(v);
const num = (v, f) => (fin(v) ? String(Math.round(f ? v * f : v)) : '--');

function font(ctx, name) { const F = ctx.fonts && ctx.fonts[name]; return F && F.adv && F.glyphs ? F : null; }
function widthOf(ctx, name, s) {
    const F = font(ctx, name);
    if (!F) return 0;
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    return String(s).split('').reduce((n, ch) => { const c = F.glyphs.indexOf(ch); return n + F.adv[c < 0 ? blank : c]; }, 0);
}
/* items [{ s, x (screen px), align }] in one text layer (P.text[layer]: its x, width, font) */
function place(ctx, P, layer, items) {
    const L = P.text[layer], F = font(ctx, L.font);
    if (!F) return null;
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    const codes = [], pos = [];
    items.forEach((it) => {
        const cs = String(it.s).split('').map((ch) => { const c = F.glyphs.indexOf(ch); return c < 0 ? blank : c; });
        const w = cs.reduce((n, c) => n + F.adv[c], 0);
        let x = it.x - L.x - (it.align === 'right' ? w : it.align === 'center' ? w / 2 : 0);
        cs.forEach((c) => { if (codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += F.adv[c]; });
    });
    const order = codes.map((c, i) => i).sort((a, b) => pos[a] - pos[b]);
    const u_text = [], u_pos = [];
    for (let i = 0; i < 16; i++) {
        if (i < order.length) { u_text.push(codes[order[i]]); u_pos.push(pos[order[i]]); } else { u_text.push(blank); u_pos.push(100000); }
    }
    return { uniforms: { u_text, u_pos, u_meta: [L.w, F.glyphs.length, F.cell[0], order.length] } };
}
function put(out, layer, placed) {
    if (!placed || !out[layer]) return;
    const o = Object.assign({}, out[layer], placed);
    o.uniforms = Object.assign({}, out[layer].uniforms, placed.uniforms);
    delete o.text;
    out[layer] = o;
}

module.exports = {
    update(sig, ctx, out, h) {
        const P = h.P, A = P.at || {}, C = h.C, lets = h.lets;
        const st = ctx.state.lci1c || (ctx.state.lci1c = {});
        const s = sig || {};

        /* the meter: charge 730-840, eco 840-1080, power 1080-1190 */
        const M = P.meter, eng = lets.eng, ele = lets.ele;
        let pw = null;
        if (fin(ele) && ele < -1) pw = Math.max(-0.9, ele / M.regenHp);
        else if (fin(eng) || fin(ele)) pw = Math.min(0.95, (Math.max(0, eng || 0) + Math.max(0, ele || 0)) / M.sysHp);
        const xv = pw == null ? M.zero : pw < 0 ? M.zero + pw * 110 : pw <= M.ecoTo ? M.zero + pw * 400 : 1080 + (pw - M.ecoTo) * 275;
        const regen = pw != null && pw < -0.01;
        const col = regen ? C.ice : fin(eng) && eng > 0.5 ? C.text : C.ice;
        const n = regen ? 58 : 230, cw = M.w / n;
        const a = Math.round((Math.min(M.zero, xv) - M.x) / cw), b = Math.round((Math.max(M.zero, xv) - M.x) / cw);
        out.meter = { visible: true, uniforms: { u_led: [n, n, 0, 0], u_geom: [M.w, M.h, regen ? 4 : 2, M.h], u_split: [a, b, 0, 0],
            u_c0: NONE, u_c1: col, u_c2: NONE } };

        /* the rest ten times a second */
        const slot = Math.floor(ctx.t * 10);
        if (!(st.slot === slot && st.slow)) {
            st.slot = slot;
            const o = {};
            if (P.at && font(ctx, P.text.avgEv.font)) {
                o.zones = place(ctx, P, 'zones', pw == null ? [] : pw < -0.03 ? [{ s: 'CHARGE', x: A.zoneCharge, align: 'center' }]
                    : pw > M.ecoTo ? [{ s: 'POWER', x: A.zonePower, align: 'center' }] : [{ s: 'ECO', x: A.zoneEco, align: 'center' }]);
                /* average and on electric, the unit after the second */
                const avg = fin(s.avgL100) && s.avgL100 > 0 ? Math.min(99.9, P.mpg / s.avgL100).toFixed(1) : '--';
                const ev = fin(s.evTripKm) ? (s.evTripKm / KM_MI).toFixed(1) : '--';
                o.avgEv = place(ctx, P, 'avgEv', [{ s: avg, x: A.avgEnd, align: 'right' }, { s: ev, x: A.ev }]);
                o.evUnit = place(ctx, P, 'evUnit', [{ s: 'mi', x: A.ev + widthOf(ctx, P.text.avgEv.font, ev) + 6 }]);
                /* arrival: "Arrive 16:12   23.0 mi to go", centred */
                const eta = typeof s.eta === 'string' && /^\d{1,2}:\d{2}$/.test(s.eta) ? s.eta : '--:--';
                const togo = fin(s.destKm) ? (s.destKm / KM_MI).toFixed(1) : '--';
                const fW = P.text.arriveWords.font, fN = P.text.arriveNums.font;
                const wA = widthOf(ctx, fW, 'Arrive '), wE = widthOf(ctx, fN, eta), wD = widthOf(ctx, fN, togo), wT = widthOf(ctx, fW, ' mi to go');
                const x0 = A.arriveMid - (wA + wE + 22 + wD + wT) / 2;
                o.arriveWords = place(ctx, P, 'arriveWords', [{ s: 'Arrive', x: x0 }, { s: 'mi to go', x: x0 + wA + wE + 22 + wD + widthOf(ctx, fW, ' ') }]);
                o.arriveNums = place(ctx, P, 'arriveNums', [{ s: eta, x: x0 + wA }, { s: togo, x: x0 + wA + wE + 22 }]);
                /* cruise: its unit after the set speed, none while off */
                const cs = fin(s.cruiseKmh) ? String(Math.round(s.cruiseKmh / KM_MI)) : null;
                o.cruiseUnit = place(ctx, P, 'cruiseUnit', cs ? [{ s: 'mph', x: A.cruise + widthOf(ctx, P.text.avgEv.font, cs) + 6 }] : []);
                /* the next turn: yards under a quarter mile, the unit at the right */
                let ds = '--', du = '';
                if (fin(s.turnM)) {
                    if (s.turnM < 402) { ds = String(Math.max(10, Math.round(s.turnM * YD / 10) * 10)); du = 'yd'; } else { ds = (s.turnM / 1609.344).toFixed(1); du = 'mi'; }
                }
                const wU = du ? widthOf(ctx, P.text.evUnit.font, du) + 6 : 0;
                o.manDist = place(ctx, P, 'manDist', [{ s: ds, x: A.manEnd - wU, align: 'right' }]);
                /* range and fluids beside their bars; mpg now, or EV */
                const electric = !!lets.electric;
                const ins = fin(s.instL100) ? (s.instL100 > 0 ? Math.min(P.mpgMax, P.mpg / s.instL100) : P.mpgMax) : null;
                o.fluids = place(ctx, P, 'fluids', [{ s: num(s.rangeKm, 1 / KM_MI), x: A.fuelEnd, align: 'right' }, { s: num(s.evRangeKm, 1 / KM_MI), x: A.batEnd, align: 'right' },
                    { s: num(s.coolantC), x: A.coolEnd, align: 'right' }, { s: electric ? 'EV' : ins != null ? String(Math.round(ins)) : '--', x: A.mpgEnd, align: 'right' }]);
                o.percents = place(ctx, P, 'percents', [{ s: num(s.fuelPct) + ' %', x: A.pctFuel }, { s: num(s.socPct) + ' %', x: A.pctBat }]);
                /* corners: the trip and the tyres' psi; outside (the odometer is its own layer, between the warning lights and the gear) */
                const ty = (i) => (s.tyres && s.tyres[i]) || {};
                o.cornerTop = place(ctx, P, 'cornerTop', [{ s: fin(s.tripKm) ? (s.tripKm / KM_MI).toFixed(1) + ' mi' : '-- mi', x: A.trip }]
                    .concat([0, 1, 2, 3].map((i) => ({ s: num(ty(i).bar, PSI), x: A['t' + i], align: 'center' }))));
                const oc = s.outsideC;
                o.cornerBot = place(ctx, P, 'cornerBot', [{ s: fin(oc) ? (oc < 0 ? '−' : '+') + Math.abs(oc).toFixed(1) + ' °C' : '-- °C', x: A.outside }]);
            }
            st.slow = o;
        }
        Object.keys(st.slow).forEach((k) => put(out, k, st.slow[k]));
        return out;
    },
};
