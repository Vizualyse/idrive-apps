// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// lci1: what the design's attributes can't say.
//  - Several readings share one text layer (boost and g; engine and
//    electric; the tyres' rows; the four fluids; the two ranges; "System"
//    and its number): laid out here at their screen x with the font's
//    advances (ctx.fonts), as the hand port did. Before the theme is built
//    (ctx.fonts empty) the bindings' plain text stands.
//  - The gear: after the M in manual, else centred in the box.
//  - Engine and electric power on one row of lights: engine leftward from
//    the divider, electric rightward, in stripes while recovering.
// UK units; a reading the car does not give shows "--".
'use strict';
const KM_MI = 1.609344, PSI = 14.5038;
const fin = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
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
    /* ascending left edges: the shader takes the last glyph left of a pixel */
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
        const P = h.P, A = P.at || {}, lets = h.lets;
        const st = ctx.state.lci1 || (ctx.state.lci1 = {});
        const s = sig || {};

        /* engine and electric power: one row of lights, a gap in its middle */
        const eng = lets.eng, ele = lets.ele;
        const regen = fin(ele) && ele < -1;
        const n = regen ? 56 : 220, half = n / 2;
        const kE = fin(eng) ? Math.round(clamp(eng / P.engMaxHp, 0, 1) * half) : 0;
        const kL = fin(ele) ? Math.round(clamp(Math.abs(ele) / P.eleMaxHp, 0, 1) * half) : 0;
        out.powerBar = { visible: true, uniforms: { u_led: [n, half + kL, 0, 0], u_geom: [P.power.w, P.power.h, regen ? 4 : 2, P.power.h],
            u_split: [half - kE, half, 0, 0] } };

        /* the gear, every tick */
        if (P.at) {
            const mode = s.gearMode, g = s.gear;
            const gs = fin(g) ? (g === 0 ? 'N' : String(g)) : '--';
            let items;
            if (mode === 'M') items = [{ s: gs, x: A.gearM }];
            else if (/^[PRN]$/.test(mode || '')) items = [{ s: mode, x: A.gearMid, align: 'center' }];
            else if (/^[DS]$/.test(mode || '')) items = [{ s: mode + (fin(g) && g > 0 ? g : ''), x: A.gearMid, align: 'center' }];
            else items = [{ s: gs, x: A.gearMid, align: 'center' }];
            put(out, 'gearText', place(ctx, P, 'gearText', items));
        }

        /* the shared layers, ten times a second */
        const slot = Math.floor(ctx.t * 10);
        if (!(st.slot === slot && st.slow)) {
            st.slot = slot;
            const o = {};
            if (P.at && font(ctx, P.text.val160.font)) {
                const boost = lets.boost;
                const gv = fin(s.gLat) && fin(s.gLon) ? Math.sqrt(s.gLat * s.gLat + s.gLon * s.gLon).toFixed(1) : '--';
                o.val160 = place(ctx, P, 'val160', [{ s: fin(boost) ? Math.max(0, boost).toFixed(1) : '--', x: A.boost }, { s: gv, x: A.gEnd, align: 'right' }]);
                const engS = fin(eng) ? String(Math.round(Math.max(0, eng))) : '--';
                const er = fin(ele) ? Math.round(ele) : null;
                const eleS = er == null ? '--' : (er < 0 ? '−' : '') + Math.abs(er);
                o.val156 = place(ctx, P, 'val156', [{ s: engS, x: A.engEnd, align: 'right' }, { s: eleS, x: A.ele }]);
                o.eleUnit = place(ctx, P, 'eleUnit', [{ s: 'hp', x: A.ele + widthOf(ctx, P.text.val156.font, eleS) + 6 }]);
                /* "System 400 hp", centred */
                const sys = fin(eng) && er != null ? String(Math.max(0, Math.round(Math.max(0, eng)) + Math.max(0, er))) : '--';
                const fW = P.text.sysWords.font, fN = P.text.sysNum.font;
                const wA = widthOf(ctx, fW, 'System '), wN = widthOf(ctx, fN, sys), wB = widthOf(ctx, fW, ' hp');
                const x0 = A.sysMid - (wA + wN + wB) / 2;
                o.sysWords = place(ctx, P, 'sysWords', [{ s: 'System', x: x0 }, { s: 'hp', x: x0 + wA + wN + widthOf(ctx, fW, ' ') }]);
                o.sysNum = place(ctx, P, 'sysNum', [{ s: sys, x: x0 + wA }]);
                /* tyres FL FR RL RR: psi, temperature */
                const ty = (i) => (s.tyres && s.tyres[i]) || {};
                const psi = (i) => num(ty(i).bar, PSI);
                const tc = (i) => (fin(ty(i).c) ? Math.round(ty(i).c) + ' °C' : '-- °C');
                o.psiF = place(ctx, P, 'psiF', [{ s: psi(0), x: A.psiFLEnd, align: 'right' }, { s: psi(1), x: A.psiFR }]);
                o.psiR = place(ctx, P, 'psiR', [{ s: psi(2), x: A.psiRLEnd, align: 'right' }, { s: psi(3), x: A.psiRR }]);
                o.tempF = place(ctx, P, 'tempF', [{ s: tc(0), x: A.tempLEnd, align: 'right' }, { s: tc(1), x: A.tempR }]);
                o.tempR = place(ctx, P, 'tempR', [{ s: tc(2), x: A.tempLEnd, align: 'right' }, { s: tc(3), x: A.tempR }]);
                /* fluids and charge beside their bars, ranges in miles */
                o.fluids = place(ctx, P, 'fluids', [{ s: num(s.fuelPct), x: A.fuelEnd, align: 'right' }, { s: num(s.socPct), x: A.batEnd, align: 'right' },
                    { s: num(s.oilC), x: A.oilEnd, align: 'right' }, { s: num(s.coolantC), x: A.coolEnd, align: 'right' }]);
                o.ranges = place(ctx, P, 'ranges', [{ s: num(s.rangeKm, 1 / KM_MI) + ' mi', x: A.rangeFuel }, { s: num(s.evRangeKm, 1 / KM_MI) + ' mi', x: A.rangeBat }]);
            }
            st.slow = o;
        }
        Object.keys(st.slow).forEach((k) => put(out, k, st.slow[k]));
        return out;
    },
};
