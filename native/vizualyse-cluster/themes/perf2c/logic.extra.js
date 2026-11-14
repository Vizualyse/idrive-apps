// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// perf2c: what the design's attributes can't say.
// - The trails: dim before half their swept part, the glow trailing all of it.
// - The demand bar, -0.5 (charge) .. 0 .. eco .. 1 (power) of the system's
//   power: the engine's part frost, the electric part blue after it,
//   charging hatched blue left of zero; its zone word lit.
// - The turn arrow flipped for a left turn; the distance's unit follows the
//   figures (the font's advances).
// A reading the car does not give shows "--" or hides; nothing is made up.
'use strict';
const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

module.exports = {
    update(sig, ctx, out, x) {
        const L = x.lets, P = x.P, C = x.C;
        const st = ctx.state.extra || (ctx.state.extra = {});
        if (!st.dem) st.dem = new ctx.core.Spring(8);
        const len = P.dialLen;

        /* the trails */
        if (out.speed.visible) {
            const f = clamp(L.vMph / P.maxMph, 0, 1);
            out.speed.uniforms = { u_val: [f, len, f * 0.5, Math.max(f, 0.01)] };
        }
        if (out.tach.visible) {
            const f = clamp(Math.max(0, L.vRpm) / P.maxRpm, 0, 1);
            out.tach.uniforms = { u_val: [f, len, f * 0.5, Math.max(f, 0.01)] };
        }

        /* demand */
        const B = P.bars;
        const eng = ok(sig.engineHp) ? Math.max(0, sig.engineHp) : null, ele = ok(sig.elecHp) ? sig.elecHp : null;
        const dRaw = ok(eng) || ok(ele) ? ((eng || 0) + (ele || 0)) / P.demandHp : null;
        const d = st.dem.step(ok(dRaw) ? clamp(dRaw, B.dMin, B.dMax) : null, ctx.dt);
        const td = (v) => (clamp(v, B.dMin, B.dMax) - B.dMin) / (B.dMax - B.dMin) * B.dT1;
        const t0 = td(0);
        if (ok(d) && d < -0.004) {
            /* charging: blue in 6 px stripes with 3 px gaps, left of zero */
            out.demand = { visible: true, value: td(d), color: C.blue, red: C.blue,
                uniforms: { u_val: [td(d), B.len, 2, 0], u_seg: [60, 3, t0, t0 + 540 / B.len] } };
        } else if (ok(d)) {
            /* the electric share of the demand continues the engine's in blue */
            const eShare = ok(ele) && ele > 0 && dRaw > 0 ? clamp(ele / ((eng || 0) + ele), 0, 1) : 0;
            out.demand = { visible: true, value: td(d), color: C.cool, red: C.blue,
                uniforms: { u_val: [td(d), B.len, td(d * (1 - eShare)), 0], u_seg: [0, 0, t0, 1] } };
        } else out.demand = { visible: true, value: t0, uniforms: { u_val: [t0, B.len, 2, 0], u_seg: [0, 0, t0, 1] } };
        const zone = !ok(d) ? -1 : d < -0.02 ? 0 : d <= P.eco ? 1 : 2;
        out.zoneC = Object.assign({}, out.zoneC, { color: zone === 0 ? C.blue : C.ink3 });
        out.zoneE = Object.assign({}, out.zoneE, { color: zone === 1 ? C.ink : C.ink3 });
        out.zoneP = Object.assign({}, out.zoneP, { color: zone === 2 ? C.ink : C.ink3 });

        /* the turn arrow: the field is a right turn; mirrored for a left one */
        /* (the shader mirrors it about its layer's middle, 3 px right of the mockup's arrow box's:
         * moved back; P.arrowX is the layer's x in the built theme) */
        if (out.arrowTurn.visible) {
            const left = sig.turnDir === 'left';
            out.arrowTurn = Object.assign({}, out.arrowTurn, { uniforms: { u_pool: [0, 0, 0, left ? 1 : 0] }, x: P.arrowX + (left ? P.arrowFlipDx : 0) });
        }

        /* the distance's unit just after its figures */
        const fonts = ctx.fonts || {};
        const f48 = Object.keys(fonts).filter((n) => /^f48w/.test(n)).map((n) => fonts[n])[0];
        const s = out.distText && out.distText.text != null ? String(out.distText.text) : '';
        let w = s.length * 24;
        if (f48 && f48.adv) w = s.split('').reduce((a, c) => { const i = f48.glyphs.indexOf(c); return a + (i >= 0 ? f48.adv[i] : 24); }, 0);
        /* a new object: a layer with data-rate hands back the same one between its evaluations */
        if (out.distUnit && out.distUnit.x != null) out.distUnit = Object.assign({}, out.distUnit, { x: out.distUnit.x + w });
        return out;
    },
};
