// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// g20i1: what the design's attributes can't say. 0-60 mph, timed from a
// standstill on the car's own speed (state across ticks); "--" until done.
'use strict';
module.exports = {
    update(sig, ctx, out) {
        const st = ctx.state;
        const kmh = sig.kmh;
        if (kmh != null && isFinite(kmh)) {
            if (kmh < 0.5) st.launch = { t: null };
            else if (st.launch && st.launch.t == null) st.launch.t = ctx.t;
            if (st.launch && st.launch.t != null && kmh / 1.609344 >= 60) { st.z60 = ctx.t - st.launch.t; st.launch = null; }
        }
        out.z60Text = Object.assign({}, out.z60Text, { text: st.z60 > 0 ? st.z60.toFixed(1) : '--' });
    },
};
