// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// tri1 "Three-dial 1" (Sport): the three-ring mockup's behaviour on the
// theme's layers. Centre: the rev band's ribs lit up to the revs (white, red
// past 7000), the needle, the shift segments closing to the middle, then all
// red with the bezel white and the gear red at the cue; speed, M + gear and
// its neighbours, rpm. Left: engine and electric power on the bezel arcs
// (electric dimmer and "Recovering" in regen), total, oil, coolant, boost.
// Right: fuel and battery arcs, tyres by temperature, range, fuel %.
// UK units (mph, miles, psi, °C). A reading the source doesn't give shows
// "--"; nothing is made up.
'use strict';
const MPH = 0.621371, PSI = 14.5038;
const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const signed = (s) => s.replace(/^-/, '−');
/* thousands grouped with a space, as the mockup sets them: 15 110 */
const grp = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/* A layer holding several numbers, each on its own anchor: the glyph codes
 * and left edges laid out here with the font's advances (THEMES.md, text v2). */
function lay(p, fonts, name, strs) {
    const L = p.lay[name], F = fonts[L.font];
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    const codes = [], pos = [];
    strs.forEach((s, i) => {
        const a = L.anchors[i];
        const cs = String(s).split('').map((c) => { const k = F.glyphs.indexOf(c); return k < 0 ? blank : k; });
        const w = cs.reduce((n, c) => n + F.adv[c], 0);
        let x = a.align === 'right' ? a.x - w : a.align === 'center' ? a.x - w / 2 : a.x;
        cs.forEach((c) => { if (codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += F.adv[c]; });
    });
    const n = codes.length;
    for (let i = n; i < 16; i++) { codes.push(blank); pos.push(100000); }
    return { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, F.glyphs.length, F.cell[0], n] } };
}

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        st.rpm = st.rpm || new core.Spring(18);
        st.eng = st.eng || new core.Spring(12);
        st.el = st.el || new core.Spring(10);
        const rpm = st.rpm.step(sig.rpm, ctx.dt);
        const eng = st.eng.step(sig.engineHp, ctx.dt), el = st.el.step(sig.elecHp, ctx.dt);
        const out = {};
        const a = (c, al) => [c[0], c[1], c[2], al];

        /* the rev band: each half dims its ribs above the revs; the needle at the revs.
         * Left half: t 0 at 4000 rpm (the top) .. 1 at 0; right half: t 0 at 4000 .. 1 at 8000. */
        const len = p.len.ribs, half = p.rmax / 2;
        const redT = p.red / half - 1;
        if (ok(rpm)) {
            const tl = 1 - rpm / half, tr = rpm / half - 1;
            out.ribsL = { needle: C.sport, uniforms: { u_v: [tl, len, 2, 0], u_seg: [0, 0, Math.min(0, tl), 1] } };
            out.ribsR = { needle: C.sport, uniforms: { u_v: [tr, len, redT, 0], u_seg: [0, 0, 1, 1] } };
        } else {
            out.ribsL = { needle: a(C.sport, 0), uniforms: { u_v: [1, len, 2, 0], u_seg: [0, 0, 0, 1] } };
            out.ribsR = { needle: a(C.sport, 0), uniforms: { u_v: [0, len, redT, 0], u_seg: [0, 0, 1, 1] } };
        }

        /* shift segments: six ranks from the outer ends in, the last two red;
         * at the cue all red, the bezel white and the gear red (held, as the mockup holds it) */
        const cue = ok(rpm) && rpm >= p.cue;
        const n = cue ? 6 : ok(rpm) ? clamp(Math.floor((rpm - p.segFrom) / (p.cue - p.segFrom) * 6 + 0.001), 0, 6) : 0;
        const seg = { visible: n > 0, uniforms: { u_v: [p.segT0 - n * p.segStep, len, p.segT0 - 4 * p.segStep, 0] },
            red: cue ? C.sport : C.ink, needle: a(C.ink, cue ? 1 : 0) };
        out.segsL = seg;
        out.segsR = seg;

        /* speed, gear, rpm */
        out.speed = { text: num(sig.kmh, MPH) };
        const g = sig.gear;
        out.gear = { text: !ok(g) ? '--' : g === 0 ? 'N' : g < 0 ? 'R' : String(g), color: cue ? C.sport : C.ink };
        out.mode = { text: ok(g) && g > 0 && typeof sig.gearMode === 'string' ? sig.gearMode.slice(0, 1) : ' ' };
        out.neighbours = lay(p, ctx.fonts, 'neighbours', ok(g) && g > 0 ? [g > 1 ? String(g - 1) : '', g < 8 ? String(g + 1) : ''] : ['', '']);
        out.rpm = { text: ok(sig.rpm) ? grp(Math.round(sig.rpm / 100) * 100) : '--' };
        out.avg = { text: num(sig.avgKmh, MPH) };

        /* corners */
        out.clock = { text: typeof sig.clock === 'string' && sig.clock ? sig.clock : '--:--' };
        out.outside = { text: ok(sig.outsideC) ? signed(String(Math.round(sig.outsideC))) : '--' };
        out.odo = { text: (ok(sig.odoKm) ? grp(Math.floor(sig.odoKm * MPH)) : '--') + ' mi' };
        out.trip = { text: 'Trip ' + (ok(sig.tripKm) ? (sig.tripKm * MPH).toFixed(1) : '--') + ' mi' };

        /* power: engine and electric on the left ring's arcs, the total between */
        out.eng = { value: ok(eng) ? clamp(eng / p.engMaxHp, 0, 1) : 0 };
        const rec = ok(el) && el < -1;
        out.elec = { value: ok(el) ? clamp(Math.abs(el) / p.elMaxHp, 0, 1) : 0, color: rec ? C.elecDim : C.elec };
        out.engV = { text: ok(eng) ? String(Math.round(Math.max(0, eng))) : '--' };
        out.elV = { text: ok(el) ? String(Math.round(Math.abs(el))) : '--' };
        out.elLabel = { text: rec ? 'Recovering' : 'Electric' };
        out.total = { text: ok(eng) && ok(el) ? String(Math.round(Math.max(0, eng) + Math.max(0, el))) : '--' };
        out.temps = lay(p, ctx.fonts, 'temps', [num(sig.oilC), num(sig.coolantC),
            ok(sig.boostBar) ? signed(sig.boostBar.toFixed(1)) : '--']);

        /* right ring: fuel and battery arcs, range, fuel %, battery % */
        out.fuel = { value: ok(sig.fuelPct) ? clamp(sig.fuelPct / 100, 0, 1) : 0 };
        out.bat = { value: ok(sig.socPct) ? clamp(sig.socPct / 100, 0, 1) : 0 };
        out.range = { text: num(sig.rangeKm, MPH) };
        out.fuelLabel = { text: 'Fuel ' + num(sig.fuelPct) + ' %' };
        out.soc = { text: num(sig.socPct) };

        /* tyres FL FR RL RR: the cell by temperature (blue cold, green, amber hot;
         * hollow grey without a reading), pressure in psi, temperature */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        for (let i = 0; i < 4; i++) {
            const c = ty(i).c;
            const col = !ok(c) ? null : c < p.tyreCold ? C.cold : c >= p.tyreHot ? C.warm : C.ok;
            out['tyre' + i] = col ? { color: col, ring: C.none } : { color: C.none, ring: C.line };
            out['tyreT' + i] = { text: num(c) + ' °C', color: col && col !== C.ok ? col : C.ink2 };
        }
        out.psiF = lay(p, ctx.fonts, 'psiF', [num(ty(0).bar, PSI), num(ty(1).bar, PSI)]);
        out.psiR = lay(p, ctx.fonts, 'psiR', [num(ty(2).bar, PSI), num(ty(3).bar, PSI)]);
        return out;
    },
};
