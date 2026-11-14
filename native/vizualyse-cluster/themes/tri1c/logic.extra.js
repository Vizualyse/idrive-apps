// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// tri1c: what the design's attributes can't say.
// - The speed band is one field along the left half of the ring, from 0.5
//   degrees right of the top (P.a0: the halves overlap, so no seam; 80 mph
//   at the top) down to 0, the right half its mirror (to 160 mph); t =
//   (a0 + degrees from the top into the half) / 135.5. A
//   binding's value is 0..1, but the needle, the limit arc and the cruise
//   mark must reach past a half's end into the other half near 80 mph, and
//   a half's dimmed band must be empty once the speed is past it: so their
//   values go here as uniforms, unclamped; a mark's half is drawn only when
//   the mark reaches into it.
// - The distance's unit sits after the distance, whose width changes.
'use strict';
module.exports = {
    update(sig, ctx, out, x) {
        const P = x.P, C = x.C, v = x.lets.vMph;
        const half = P.vmax / 2, len = P.ribLen, span = 135 + P.a0;
        const tOf = (deg) => (P.a0 + deg) / span;          /* degrees into a half from the top -> t */
        const ok = (n) => typeof n === 'number' && isFinite(n);
        const none = [C.ink[0], C.ink[1], C.ink[2], 0];
        if (ok(v)) {
            const tl = tOf((1 - v / half) * 135), tr = tOf((v / half - 1) * 135);
            out.ribsL = { visible: tl > -0.03, needle: C.ink, uniforms: { u_val: [tl, len, 2, 0], u_seg: [0, 0, Math.min(0, tl), 1] } };
            out.ribsR = { visible: true, needle: C.ink, uniforms: { u_val: [tr, len, 2, 0], u_seg: [0, 0, 1, 1] } };
        } else {
            out.ribsL = { visible: true, needle: none, uniforms: { u_val: [1, len, 2, 0], u_seg: [0, 0, 0, 1] } };
            out.ribsR = { visible: true, needle: none, uniforms: { u_val: [0, len, 2, 0], u_seg: [0, 0, 1, 1] } };
        }
        /* the limit arc and the cruise mark, in whole mph */
        const mark = (name, kmh, deg) => {
            if (!ok(kmh)) { out[name + 'L'] = { visible: false }; out[name + 'R'] = { visible: false }; return; }
            const a = (Math.max(0, Math.min(P.vmax, Math.round(kmh / 1.609344))) / half - 1) * 135, m = deg / span;
            const tl = tOf(-a), tr = tOf(a);
            out[name + 'L'] = { visible: tl > -m, uniforms: { u_val: [tl, len, 2, 0] } };
            out[name + 'R'] = { visible: tr > -m, uniforms: { u_val: [tr, len, 2, 0] } };
        };
        mark('limit', sig.limitKmh, P.limitDeg);
        mark('set', sig.cruiseKmh, P.setDeg);

        /* the unit after the distance (the distance's font: 34 px, 600) */
        const F = ctx.fonts && ctx.fonts.f34w600;
        const adv = (c) => {
            const k = F && F.glyphs ? F.glyphs.indexOf(c) : -1;
            return k >= 0 && F.adv ? F.adv[k] : c === '.' ? 8 : 19;
        };
        const d = out.dist && out.dist.text != null ? String(out.dist.text) : '--';
        const w = d.split('').reduce((n, c) => n + adv(c), 0);
        const shift = sig.turnDir === 'right' ? P.turnShift : 0;
        out.distUnit = Object.assign({}, out.distUnit, { x: P.distX + shift + w + 5 });
        return out;
    },
};
