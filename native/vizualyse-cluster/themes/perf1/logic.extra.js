// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// perf1: what the design's attributes can't say.
//  - Rows: several readings in one font, colour and baseline share a text
//    layer (P.rows: its font, x and width), each placed as the mockup places
//    it, and each unit 8 px after its number's last digit. Laid out here from
//    the font's advances (ctx.fonts); at build time (no fonts yet) a row says
//    its characters as text, which picks the atlas's glyphs.
//  - The boost peak of the pull: kept until the next pull starts after 3 s
//    off boost; its mark moves along the boost bar.
'use strict';
const MI = 1.609344, PSI = 14.5038;
const fin = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, k) => (fin(v) ? String(Math.round(k ? v * k : v)) : '--');

/* a row's uniforms from items { s, x (panel px), anchor: start|middle|end }; each item's width */
function row(ctx, P, name, items) {
    const R = P.rows[name], f = ctx.fonts && ctx.fonts[R.f];
    if (!f || !f.adv) return { out: { visible: true, text: items.map((it) => String(it.s)).join('').slice(0, 16) }, widths: items.map(() => 0) };
    const blank = Math.max(0, f.glyphs.indexOf(' '));
    const glyphs = [], widths = [];
    items.forEach((it) => {
        const cs = String(it.s).split('').map((c) => { const i = f.glyphs.indexOf(c); return i < 0 ? blank : i; });
        const w = cs.reduce((a, c) => a + f.adv[c], 0);
        widths.push(w);
        let x = (it.anchor === 'end' ? it.x - w : it.anchor === 'middle' ? it.x - w / 2 : it.x) - R.x;
        cs.forEach((c) => { if (c !== blank) glyphs.push([Math.round(x), c]); x += f.adv[c]; });
    });
    /* text.frag wants the left edges ascending */
    glyphs.sort((a, b) => a[0] - b[0]);
    const codes = glyphs.slice(0, 16).map((g) => g[1]), pos = glyphs.slice(0, 16).map((g) => g[0]);
    const n = codes.length;
    for (let i = n; i < 16; i++) { codes.push(blank); pos.push(100000); }
    return { out: { visible: true, uniforms: { u_text: codes, u_pos: pos, u_meta: [R.w, f.glyphs.length, f.cell[0], n] } }, widths };
}

module.exports = {
    update(sig, ctx, out, o) {
        const P = o.P, L = o.lets, st = ctx.state;
        const put = (name, items) => { const r = row(ctx, P, name, items); out[name] = r.out; return r.widths; };
        const signed = (n) => (!fin(n) ? '--' : n > 0 ? '+' + n : n < 0 ? '−' + -n : '0');

        /* power: the engine figure, the electric one signed; "hp" after the engine's */
        const e = L.e, l = L.l;
        const pw = put('pw', [{ s: num(e), x: 648 }, { s: signed(l), x: 1240, anchor: 'end' }]);
        put('pwUnit', [{ s: 'hp', x: 648 + pw[0] + 8 }]);

        /* boost (vacuum shows as 0.00) and the peak of the pull */
        const b = fin(L.bst) ? L.bst : null;
        if (b != null) {
            st.off = b <= 0.05 ? (st.off || 0) + ctx.dt : st.off || 0;
            if (b > 0.3 && st.off > 3) st.peak = 0;
            if (b > 0.05) st.off = 0;
            st.peak = Math.max(st.peak || 0, b);
        }
        out.peakMark = b == null ? { visible: false } : { visible: true, x: 647 + clamp(st.peak / P.boostMax, 0, 1) * 160 };
        out.peak = { text: b == null ? '--' : st.peak.toFixed(2) };

        /* boost | HV battery */
        const soc = sig.socPct;
        const n436 = put('n436', [{ s: b == null ? '--' : b.toFixed(2), x: 648 }, { s: num(soc), x: 1112 }]);
        put('u436', [{ s: 'bar', x: 648 + n436[0] + 8 }, { s: '%', x: 1112 + n436[1] + 8 }]);

        /* tyres FL FR RL RR: pressure (psi), temperature (deg C) */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        const psi = (i) => num(ty(i).bar, PSI), tc = (i) => num(ty(i).c);
        put('psiF', [{ s: psi(0), x: 894, anchor: 'end' }, { s: psi(1), x: 1026 }]);
        put('tempF', [{ s: tc(0), x: 894, anchor: 'end' }, { s: tc(1), x: 1026 }]);
        put('tempR', [{ s: tc(2), x: 894, anchor: 'end' }, { s: tc(3), x: 1026 }]);

        /* y 618: 12 V, rear pressures, electric range | fuel (litres of the tank), range, oil, coolant; the units */
        const v12 = fin(sig.volts12) ? sig.volts12.toFixed(1) : '--';
        const ns = put('n618s', [{ s: v12, x: 648 }, { s: psi(2), x: 894, anchor: 'end' }, { s: psi(3), x: 1026 },
            { s: num(sig.evRangeKm, 1 / MI), x: 1112 }]);
        const fuelL = fin(sig.fuelPct) ? String(Math.round(sig.fuelPct / 100 * P.tankL)) : '--';
        const nb = put('n618', [{ s: fuelL, x: 170 }, { s: num(sig.rangeKm, 1 / MI), x: 350 },
            { s: num(sig.oilC), x: 1430 }, { s: num(sig.coolantC), x: 1610 }]);
        put('u618', [{ s: 'V', x: 648 + ns[0] + 8 }, { s: 'mi', x: 1112 + ns[3] + 8 },
            { s: 'L', x: 170 + nb[0] + 8 }, { s: 'mi', x: 350 + nb[1] + 8 }, { s: '°C', x: 1430 + nb[2] + 8 }, { s: '°C', x: 1610 + nb[3] + 8 }]);
    },
};
