// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// tri1: what the design's attributes can't say. The rev band is one field
// along the left half of the ring, from 0.5 degrees right of the top (P.a0:
// the halves overlap, so no seam) down to 0 rpm, the right half its mirror
// (to 8000 rpm); t = (a0 + degrees from the top into the half) / 135.5. A
// binding's value is 0..1, but the needle (6 px wide) must reach past a
// half's end into the other half near 4000 rpm, and a half's dimmed band
// must be empty once the revs are past it: so the ribs' value and band start
// go here as uniforms, unclamped (and the shift segments' value, whose
// middle cell straddles the halves). The left half is hidden once the revs
// are well past it: the art under it is its ribs all lit.
'use strict';
module.exports = {
    update(sig, ctx, out, x) {
        const P = x.P, C = x.C, v = x.lets.vRpm;
        const half = P.rmax / 2, len = P.ribLen, span = 135 + P.a0;
        const tOf = (deg) => (P.a0 + deg) / span;          /* degrees into a half from the top -> t */
        const none = [C.sport[0], C.sport[1], C.sport[2], 0];
        if (typeof v === 'number' && isFinite(v)) {
            const tl = tOf((1 - v / half) * 135), tr = tOf((v / half - 1) * 135);
            out.ribsL = { visible: tl > -0.03, needle: C.sport, uniforms: { u_val: [tl, len, 2, 0], u_seg: [0, 0, Math.min(0, tl), 1] } };
            out.ribsR = { visible: true, needle: C.sport, uniforms: { u_val: [tr, len, P.redT, 0], u_seg: [0, 0, 1, 1] } };
        } else {
            /* no reading: every rib unlit, no needle */
            out.ribsL = { visible: true, needle: none, uniforms: { u_val: [1, len, 2, 0], u_seg: [0, 0, 0, 1] } };
            out.ribsR = { visible: true, needle: none, uniforms: { u_val: [0, len, P.redT, 0], u_seg: [0, 0, 1, 1] } };
        }
        /* the shift segments: 8-degree cells from 44 degrees in; all six
         * ranks lit is a value past the half's start (-4 degrees) */
        const n = x.lets.segN;
        if (typeof n === 'number' && n > 0) {
            ['segsL', 'segsR'].forEach((k) => {
                const o = Object.assign({}, out[k]);
                delete o.value;
                o.uniforms = Object.assign({}, o.uniforms, { u_val: [tOf(44 - 8 * n), len, P.segRedT, 0] });
                out[k] = o;
            });
        }
        return out;
    },
};
