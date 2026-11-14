// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// lci2c: what the design's attributes can't say.
// - The meter's drive side is a row of 450 one-pixel lights (more than a
//   leds layer's 64) lit to the engine's and the motor's px (the lets ew,
//   lw), the colour split at the engine's end: the light count, size and
//   split are uniforms bindings don't reach.
// - The turn's unit (mi / yd) follows the distance, which is left-aligned
//   after the arrow as in the mockup: its x from the distance's width
//   (P.turnAdv, the 48 px font's advances).
'use strict';
module.exports = {
    update(sig, ctx, out, env) {
        const L = env.lets, P = env.P;
        const fin = (v) => typeof v === 'number' && isFinite(v);
        const ew = fin(L.ew) ? L.ew : 0, lw = fin(L.lw) ? L.lw : 0;
        out.meterPos = { visible: true, uniforms: { u_led: [450, ew + lw, 0, 0], u_geom: [450, 14, 1, 14], u_split: [ew, 9999, 0, 0] } };
        if (out.turnV && out.turnU && out.turnV.text != null) {
            const w = String(out.turnV.text).split('').reduce((n, c) => n + (P.turnAdv[c] != null ? P.turnAdv[c] : P.turnAdv.d), 0);
            out.turnU = Object.assign({}, out.turnU, { x: P.turnX + w + P.turnGap });
        }
    },
};
