// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// tri2: what the design's attributes can't say.
//  - the power dial: one gauge on a field that runs counter-clockwise round
//    the whole dial from zero. It dims everything past the reading and tints
//    the electric share teal (the art's white grooves less a colour), which
//    takes a redline that moves (u_val.z) and a glow trail of the electric
//    share's length (u_val.w);
//  - two figures in one text layer, each centred (or aligned) on its own
//    column: laid out here from the font's advances (P.lay names each
//    layer's x, width and font);
//  - the gear drops into place for 90 ms when it changes.
// A reading the car does not give shows "--" (the lets are NaN then).
'use strict';
const ok = (v) => v != null && typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* parts [{ s, x, align }] laid out in one text layer: its glyph codes and
 * left edges; plain text where the fonts are not known (the build's own run) */
function place(ctx, P, name, parts) {
    const L = P.lay[name], F = ctx.fonts && ctx.fonts[L.font];
    if (!F || !F.adv) return { text: parts.map((q) => q.s).filter((s) => s).join('  ') };
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    const codes = [], pos = [];
    parts.forEach((q) => {
        const cs = String(q.s).split('').map((c) => { const i = F.glyphs.indexOf(c); return i < 0 ? blank : i; });
        const w = cs.reduce((n, c) => n + F.adv[c], 0);
        let x = (q.align === 'right' ? q.x - w : q.align === 'center' ? q.x - w / 2 : q.x) - L.x;
        cs.forEach((c) => { if (codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += F.adv[c]; });
    });
    for (let i = 1; i < pos.length; i++) pos[i] = Math.max(pos[i], pos[i - 1]);
    const n = codes.length;
    for (let i = n; i < 16; i++) { codes.push(blank); pos.push(100000); }
    return { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, F.glyphs.length, F.cellW || F.cell[0], n] } };
}
const keep = (o, n) => Object.assign({}, o, n, n.text == null ? { text: undefined } : {});

module.exports = {
    update(sig, ctx, out, env) {
        const P = env.P, C = env.C, lets = env.lets, st = ctx.state, t = ctx.t || 0;

        /* power: zero to the engine's figure white, then the electric share teal; regen teal below zero */
        const W = P.power;
        const pA = (hp) => W.a0 + (W.a1 - W.a0) * (clamp(hp, W.lo, W.hi) - W.lo) / (W.hi - W.lo);
        const tP = (hp) => clamp((((W.start - pA(hp)) % 360) + 360) % 360 / W.span, 0, 1);
        const eng = lets.vEng, ele = lets.vEle;
        const e = ok(eng) ? Math.max(0, eng) : 0, el = ok(ele) ? ele : 0;
        const none = [0, 0, 0, 0];
        let pw;
        if (el < -0.5) pw = { value: tP(el), uniforms: { u_val: [tP(el), W.len, 2, 0], u_seg: [0, 0, 1, 1] }, glow: none };
        else {
            const tot = e + Math.max(0, el);
            if (tot <= 0.5) pw = { value: 1, uniforms: { u_val: [1, W.len, 2, 0], u_seg: [0, 0, 0, 1] }, glow: none };
            else {
                /* dimmed from the start to the total (past it, counter-clockwise), teal from the total to the engine's figure */
                const v = e > 0.5 ? tP(e) : 1, red = tP(tot), trail = el >= 1 ? v - red : 0;
                pw = { value: v, uniforms: { u_val: [v, W.len, red, trail], u_seg: [0, 0, 0, 1] }, glow: trail > 0.0005 ? P.pwTint : none };
            }
        }
        out.pw = Object.assign({}, out.pw, pw);

        /* the columns' figures */
        const X = P.colX;
        const pct = (v) => (ok(v) ? Math.round(v) + ' %' : '--');
        const deg = (v) => (ok(v) ? Math.round(v) + '°C' : '--');
        const mi = (v) => (ok(v) ? Math.round(v / 1.609344) + ' mi' : '--');
        const state = (c, hot) => (!ok(c) ? '' : c < 80 ? 'Warming' : c > hot ? 'Hot' : 'Normal');
        out.storeVal = keep(out.storeVal, place(ctx, P, 'storeVal', [{ s: pct(sig.fuelPct), x: X.fuel, align: 'center' }, { s: pct(sig.socPct), x: X.batt, align: 'center' }]));
        out.storeSub = keep(out.storeSub, place(ctx, P, 'storeSub', [{ s: mi(sig.rangeKm), x: X.fuel, align: 'center' }, { s: mi(sig.evRangeKm), x: X.batt, align: 'center' }]));
        out.tempVal = keep(out.tempVal, place(ctx, P, 'tempVal', [{ s: deg(sig.oilC), x: X.oil, align: 'center' }, { s: deg(sig.coolantC), x: X.cool, align: 'center' }]));
        out.tempSub = keep(out.tempSub, place(ctx, P, 'tempSub', [{ s: state(sig.oilC, P.oilHot), x: X.oil, align: 'center' }, { s: state(sig.coolantC, P.coolHot), x: X.cool, align: 'center' }]));

        /* the tyre flags: LOW (held once seen), COLD under 60 deg C; a row is caution when either is LOW */
        const flag = (i) => {
            const ty = (sig.tyres && sig.tyres[i]) || {};
            return lets['low' + i] ? 'LOW' : ok(ty.c) && ty.c < P.cold ? 'COLD' : '';
        };
        [['flagF', 0], ['flagR', 2]].forEach((r) => {
            const k = r[0], i = r[1], a = flag(i), b = flag(i + 1);
            out[k] = keep(out[k], place(ctx, P, k, [{ s: a, x: P.slatX[i] + 102, align: 'right' }, { s: b, x: P.slatX[i + 1] + 102, align: 'right' }]));
            out[k].color = a === 'LOW' || b === 'LOW' ? C.caution : C.z6;
        });

        /* the gear slots in: 11 px low and half lit for 90 ms after a change */
        const g = String(out.gear && out.gear.text) + '|' + String(out.gearNR && out.gearNR.text);
        if (st.gearKey !== g) { st.slotAt = st.gearKey == null ? -1 : t; st.gearKey = g; }
        if (t - st.slotAt < 0.09 && t >= st.slotAt) {
            ['gear', 'gearNR'].forEach((k) => {
                const o = out[k];
                if (!o) return;
                if (o.y != null) o.y += 11;
                const c = o.color || C.z10;
                o.color = [c[0], c[1], c[2], 0.5];
            });
        }
    },
};
