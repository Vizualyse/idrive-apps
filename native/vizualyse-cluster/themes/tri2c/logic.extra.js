// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// tri2c: what the design's attributes can't say.
//  - charge / eco / power: two gauges on one field that runs counter-clockwise
//    round the dial from zero. pwTint tints the art's grey grooves teal over
//    the electric share; pwDim dims everything past the total and puts the
//    needle on it (on the regen side when recovering);
//  - lines whose parts are in two text layers (a 16-glyph layer, or two
//    fonts), centred together on a column or the dial (P.lay names each
//    layer's x, width and font);
//  - the turn arrow mirrored in place for a left turn.
// A reading the car does not give shows "--".
'use strict';
const ok = (v) => v != null && typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MPH = 1 / 1.609344;

/* groups[k]: parts [{ s, l }] (text, index into names) centred together at
 * anchors[k]; each layer gets its glyph codes and left edges. Plain text
 * where the fonts are not known (the build's own run). */
function line(ctx, P, names, groups, anchors) {
    const fontOf = (n) => ctx.fonts && ctx.fonts[P.lay[n].font];
    const out = {};
    if (!names.every((n) => fontOf(n) && fontOf(n).adv)) {
        names.forEach((n, j) => { out[n] = { text: groups.map((g) => g.filter((q) => q.l === j).map((q) => q.s).join('')).join('  ') }; });
        return out;
    }
    const items = names.map(() => []);
    groups.forEach((g, k) => {
        const parts = g.map((q) => {
            const F = fontOf(names[q.l]), blank = Math.max(0, F.glyphs.indexOf(' '));
            const cs = String(q.s).split('').map((c) => { const i = F.glyphs.indexOf(c); return i < 0 ? blank : i; });
            return { l: q.l, cs, adv: F.adv, w: cs.reduce((n, c) => n + F.adv[c], 0) };
        });
        let x = anchors[k] - parts.reduce((n, q) => n + q.w, 0) / 2;
        parts.forEach((q) => q.cs.forEach((c) => { items[q.l].push([c, x]); x += q.adv[c]; }));
    });
    names.forEach((n, j) => {
        const L = P.lay[n], F = fontOf(n), blank = Math.max(0, F.glyphs.indexOf(' '));
        const it = items[j].slice(0, 16), codes = [], pos = [];
        it.forEach((p) => { codes.push(p[0]); pos.push(Math.max(pos.length ? pos[pos.length - 1] : -1e5, Math.round(p[1] - L.x))); });
        const cnt = codes.length;
        while (codes.length < 16) { codes.push(blank); pos.push(100000); }
        out[n] = { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, F.glyphs.length, F.cellW || F.cell[0], cnt] } };
    });
    return out;
}
const keep = (o, n) => Object.assign({}, o, n, n.text == null ? { text: undefined } : {});
function lines(ctx, P, out, names, groups, anchors) {
    const r = line(ctx, P, names, groups, anchors);
    names.forEach((n) => { out[n] = keep(out[n], r[n]); });
}

module.exports = {
    update(sig, ctx, out, env) {
        const P = env.P, lets = env.lets;

        /* charge / eco / power */
        const W = P.power;
        const pA = (hp) => W.a0 + (W.a1 - W.a0) * (clamp(hp, W.lo, W.hi) - W.lo) / (W.hi - W.lo);
        const tP = (hp) => clamp((((W.start - pA(hp)) % 360) + 360) % 360 / W.span, 0, 1);
        const eng = lets.vEng, ele = lets.vEle;
        const e = ok(eng) ? Math.max(0, eng) : 0, el = ok(ele) ? ele : 0;
        const none = [0, 0, 0, 0];
        if (el < -0.5) {
            out.pwDim = Object.assign({}, out.pwDim, { value: tP(el), uniforms: { u_seg: [0, 0, 1, 1] } });
            out.pwTint = Object.assign({}, out.pwTint, { value: 0, glow: none, uniforms: { u_seg: [0, 0, 0, 1] } });
        } else {
            const tot = e + Math.max(0, el);
            out.pwDim = Object.assign({}, out.pwDim, { value: tot > 0.5 ? tP(tot) : 1, uniforms: { u_seg: [0, 0, 0, 1] } });
            out.pwTint = Object.assign({}, out.pwTint, el >= 1
                ? { value: tP(e), glow: P.pwTint, uniforms: { u_seg: [0, 0, tP(tot), 1] } }
                : { value: 0, glow: none, uniforms: { u_seg: [0, 0, 0, 1] } });
        }

        /* the columns: "315 mi" (figure and unit centred together), the percentage beneath */
        const X = P.colX;
        const r = (v) => (ok(v) ? String(Math.round(v * MPH)) : '--');
        const unit = (v) => (ok(v) ? ' mi' : '');
        lines(ctx, P, out, ['storeVal', 'storeUnit'],
            [[{ s: r(sig.rangeKm), l: 0 }, { s: unit(sig.rangeKm), l: 1 }], [{ s: r(sig.evRangeKm), l: 0 }, { s: unit(sig.evRangeKm), l: 1 }]], [X.fuel, X.batt]);
        const pct = (v) => (ok(v) ? Math.round(v) + ' %' : '--');
        const deg = (v) => (ok(v) ? Math.round(v) + ' °C' : '--');
        const state = (c, hot) => (!ok(c) ? '' : c < 80 ? 'Warming' : c > hot ? 'Hot' : 'Normal');
        lines(ctx, P, out, ['storeSub'], [[{ s: pct(sig.fuelPct), l: 0 }], [{ s: pct(sig.socPct), l: 0 }]], [X.fuel, X.batt]);
        lines(ctx, P, out, ['tempVal'], [[{ s: deg(sig.oilC), l: 0 }], [{ s: deg(sig.coolantC), l: 0 }]], [X.oil, X.cool]);
        lines(ctx, P, out, ['tempSub'], [[{ s: state(sig.oilC, P.oilHot), l: 0 }], [{ s: state(sig.coolantC, P.coolHot), l: 0 }]], [X.oil, X.cool]);

        /* arrival, and the four pressures */
        lines(ctx, P, out, ['etaA', 'etaB'], [[{ s: 'Arrive ' + (sig.eta || '--'), l: 0 },
            { s: ' · ' + (ok(sig.destKm) ? Math.round(sig.destKm * MPH) : '--') + ' mi', l: 1 }]], [P.navX]);
        const psi = (i) => { const ty = sig.tyres && sig.tyres[i]; return ty && ok(ty.bar) ? String(Math.round(ty.bar * 14.5038)) : '--'; };
        lines(ctx, P, out, ['tyresA', 'tyresB'], [[{ s: 'Tyres ' + psi(0) + ' · ' + psi(1), l: 0 },
            { s: ' · ' + psi(2) + ' · ' + psi(3) + ' psi', l: 1 }]], [P.navX]);

        /* a left turn: the right turn's arrow mirrored in its own rectangle */
        if (out.arrow) out.arrow = Object.assign({}, out.arrow, { uniforms: { u_pool: [0, 0, 0, sig.turnDir === 'left' ? 1 : 0] } });
    },
};
