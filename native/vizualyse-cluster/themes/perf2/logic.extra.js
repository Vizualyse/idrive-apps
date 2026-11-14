// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// perf2: what the design's attributes can't say.
// - The trails: the speed trail dim before half its swept part, the glow
//   trailing all of it; the rev trail amber from the lamps' amber stage. The
//   red stage and needle on tachRed; at the shift cue its band moves out to
//   light the bezel, flashing with the lamps.
// - The power bar (engine from zero, electric deploy after it, regen hatched
//   left of zero) and the boost bar (from zero), on one path.
// - A new gear drops 14 px into place over 140 ms, from 35 %.
// A reading the car does not give shows "--" or hides; nothing is made up.
'use strict';
const MINUS = '−';
const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const signed = (v, plus) => (Math.round(v) < 0 ? MINUS : Math.round(v) > 0 && plus ? '+' : '') + Math.abs(Math.round(v));
const al = (c, a) => [c[0], c[1], c[2], a];
const NONE = [0, 0, 0, 0];

module.exports = {
    update(sig, ctx, out, x) {
        const L = x.lets, P = x.P, C = x.C;
        const st = ctx.state.extra || (ctx.state.extra = {});
        if (!st.eng) { st.eng = new ctx.core.Spring(12); st.ele = new ctx.core.Spring(12); st.boost = new ctx.core.Spring(10); }
        const len = P.dialLen;

        /* the dials */
        if (out.speed.visible) {
            const f = clamp(L.vMph / P.maxMph, 0, 1);
            out.speed.uniforms = { u_val: [f, len, f * 0.5, Math.max(f, 0.01)] };
        }
        const f = ok(L.vRpm) ? clamp(L.vRpm / P.maxRpm, 0, 1) : null;
        if (out.tach.visible) out.tach.uniforms = { u_val: [f, len, P.amberRpm / P.maxRpm, Math.max(f, 0.01)] };
        if (!ok(f)) out.tachRed = { visible: false };
        else if (L.cue) {
            out.tachRed = { visible: !!L.fl, value: 1, color: al(C.red, 0.85), red: al(C.red, 0.85), needle: NONE,
                uniforms: { u_val: [1, len, 2, 0], u_band: [-19.5, -16.5, -12, 46] } };
        } else {
            out.tachRed = { visible: true, value: f, color: NONE, red: C.red, needle: C.red,
                uniforms: { u_val: [f, len, P.redStageRpm / P.maxRpm, 0], u_band: [-6, 6, -12, 46] } };
        }

        /* power: engine from zero, electric after it; regen blue in 6 px stripes with 3 px gaps left of zero */
        const B = P.bars;
        const tp = (hp) => clamp((hp - B.pMin) / (B.pMax - B.pMin), 0, 1) * B.pT1;
        const t0 = tp(0);
        const eng = st.eng.step(ok(sig.engineHp) ? Math.max(0, sig.engineHp) : null, ctx.dt);
        const ele = st.ele.step(sig.elecHp, ctx.dt);
        if (ok(eng) || ok(ele)) {
            const E = ok(eng) ? eng : 0, El = ok(ele) ? ele : 0;
            if (El < -0.5) {
                const start = E > 0.5 ? tp(El) : t0, value = E > 0.5 ? tp(E) : tp(El);
                out.power = { visible: true, value, color: C.blue, red: C.cool,
                    uniforms: { u_val: [value, B.len, E > 0.5 ? t0 : 2, 0], u_seg: [60, 3, start, start + 540 / B.len] } };
            } else {
                out.power = { visible: true, value: tp(E + El), color: C.cool, red: C.blue,
                    uniforms: { u_val: [tp(E + El), B.len, tp(E), 0], u_seg: [0, 0, t0, 1] } };
            }
        } else out.power = { visible: true, value: t0, uniforms: { u_val: [t0, B.len, 2, 0], u_seg: [0, 0, t0, 1] } };
        const total = ok(eng) ? eng + (ok(ele) ? ele : 0) : null;
        out.powerText = { text: ok(total) ? signed(total) : '--' };
        out.engText = Object.assign({}, out.engText, { text: ok(eng) ? String(Math.round(eng)) : '--' });
        out.eleText = Object.assign({}, out.eleText, { text: ok(ele) ? signed(ele, true) : '--' });

        /* boost: from zero along the bar (the path runs right to left there) */
        const boost = st.boost.step(sig.boostBar, ctx.dt);
        const tb = (b) => B.bT0 + (B.bMax - clamp(b, B.bMin, B.bMax)) / (B.bMax - B.bMin) * (B.bT1 - B.bT0);
        out.boost = ok(boost) ? { visible: true, value: tb(boost), uniforms: { u_val: [tb(boost), B.len, 2, 0], u_seg: [0, 0, tb(0), 1] } } : { visible: false };
        out.boostText = Object.assign({}, out.boostText, { text: ok(boost) ? (boost < -0.005 ? MINUS : '') + Math.abs(boost).toFixed(2) : '--' });

        /* the gear drops into place */
        /* (a new object: a layer with data-rate hands back the same one between its evaluations) */
        const g = out.gearText = Object.assign({}, out.gearText);
        if (g.text != null) {
            if (st.gear !== undefined && st.gear !== g.text) st.gearT = ctx.t;
            st.gear = g.text;
            const k = st.gearT == null ? 1 : clamp((ctx.t - st.gearT) / 0.14, 0, 1), e = 1 - Math.pow(1 - k, 3);
            if (g.y != null) g.y += 14 * (1 - e);
            const c = g.color || C.ink;
            g.color = al(c, 0.35 + 0.65 * e);
        }
        return out;
    },
};
