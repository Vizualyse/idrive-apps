// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// The sample theme's logic: checks the pipeline end to end.
'use strict';
module.exports = {
    update(sig, ctx) {
        const st = ctx.state;
        st.rpm = st.rpm || new ctx.core.Spring(16);
        const rpm = st.rpm.step(sig.rpm, ctx.dt);
        const p = ctx.params;
        const lit = Math.max(0, Math.min(5, Math.ceil((sig.rpm - (p.shiftRpm - 1500)) / 1500 * 5)));
        const over = sig.rpm >= p.shiftRpm;
        return {
            rpm: { value: rpm == null ? 0 : rpm / p.maxRpm },
            kmh: { text: sig.kmh == null ? '--' : String(Math.round(sig.kmh)) },
            gear: { text: sig.gear == null ? '-' : (sig.gearMode || '') + sig.gear + ' ' + (sig.oilC == null ? '--' : sig.oilC.toFixed(1)) + '°' },
            shift: { lit: lit, flash: over ? (Math.floor(ctx.t * 5) % 2 ? 2 : 1) : 0 },
            chip: { color: sig.elecHp < 0 ? [0.2, 0.9, 0.5, 1] : [0.2, 0.7, 1, 1] },
        };
    },
};
