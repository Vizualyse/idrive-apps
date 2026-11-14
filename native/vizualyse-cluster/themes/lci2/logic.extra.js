// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// lci2: what the design's attributes can't say. The power bar (a row of
// 496 one-pixel lights) is engine then electric along one bar, the split at
// the engine's end; under regen it becomes a hatch from zero (81 leaning
// lights): the light count, size, lean and split change, which bindings
// don't reach.
'use strict';
module.exports = {
    update(sig, ctx, out) {
        const ok = (v) => v != null && isFinite(v);
        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
        const eng = sig.engineHp, el = sig.elecHp;
        const ew = ok(eng) ? clamp(Math.round(Math.max(0, eng) / 500 * 496), 0, 496) : 0;
        let u;
        if (ok(el) && Math.round(el) < 0) {
            const lw = clamp(Math.abs(el) / 500 * 496, 0, 496);
            u = { u_led: [81, Math.round(lw / 6), 0, 0], u_geom: [496, 12, 3.4, 12], u_split: [0, 9999, 0, 0], u_lean: [12, 0, 0, 0] };
        } else {
            const lw = ok(el) ? clamp(Math.round(el / 500 * 496), 0, 496 - ew) : 0;
            u = { u_led: [496, ew + lw, 0, 0], u_geom: [496, 12, 1, 12], u_split: [ew, 9999, 0, 0], u_lean: [0, 0, 0, 0] };
        }
        out.power = { visible: true, uniforms: u };
    },
};
