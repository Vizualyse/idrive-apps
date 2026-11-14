// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// perf1c: what the design's attributes can't say. Rows: several readings in
// one font, colour and baseline share a text layer (P.rows: its font, x and
// width), each placed as the mockup places it, each unit 8 px after its
// number's last digit, the sub-lines' numbers where their fixed words
// ("Average", the tyre line's "/" and "psi", drawn in the art) leave room.
// Laid out here from the font's advances (ctx.fonts); at build time (no
// fonts yet) a row says its characters as text, which picks the atlas's glyphs.
'use strict';
const MI = 1.609344, PSI = 14.5038;
const fin = (v) => typeof v === 'number' && isFinite(v);
const num = (v, k) => (fin(v) ? String(Math.round(k ? v * k : v)) : '--');

/* a font's width of a string (its advances; an unknown character is a space) */
function widthOf(f, s) {
    if (!f || !f.adv) return 0;
    const blank = Math.max(0, f.glyphs.indexOf(' '));
    return String(s).split('').reduce((a, c) => { const i = f.glyphs.indexOf(c); return a + f.adv[i < 0 ? blank : i]; }, 0);
}
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
        const P = o.P, L = o.lets;
        const put = (name, items) => { const r = row(ctx, P, name, items); out[name] = r.out; return r.widths; };

        /* range split: fuel | electric, in miles; "mi" after the fuel range */
        const rr = put('ranges', [{ s: num(sig.rangeKm, 1 / MI), x: 648 }, { s: num(sig.evRangeKm, 1 / MI), x: 1238, anchor: 'end' }]);
        put('rangeUnit', [{ s: 'mi', x: 648 + rr[0] + 8 }]);

        /* economy (the average, mpg) | HV battery */
        const avg = L.avgMpg;
        const n436 = put('n436', [{ s: fin(avg) ? avg.toFixed(1) : '--', x: 648 }, { s: num(sig.socPct), x: 1112 }]);
        put('u436', [{ s: 'mpg', x: 648 + n436[0] + 8 }, { s: '%', x: 1112 + n436[1] + 8 }]);

        /* y 618: electric trip, arrival | fuel (litres of the tank), trip, coolant; the units */
        const eta = typeof sig.eta === 'string' && /^\d\d?:\d\d$/.test(sig.eta) ? sig.eta : '--:--';
        const ns = put('n618s', [{ s: fin(sig.evTripKm) ? (sig.evTripKm / MI).toFixed(1) : '--', x: 648 }, { s: eta, x: 1112 }]);
        const fuelL = fin(sig.fuelPct) ? String(Math.round(sig.fuelPct / 100 * P.tankL)) : '--';
        const nb = put('n618', [{ s: fuelL, x: 170 }, { s: fin(sig.tripKm) ? (sig.tripKm / MI).toFixed(1) : '--', x: 350 },
            { s: num(sig.coolantC), x: 1430 }]);
        put('u618', [{ s: 'mi', x: 648 + ns[0] + 8 }, { s: 'L', x: 170 + nb[0] + 8 }, { s: 'mi', x: 350 + nb[1] + 8 },
            { s: '°C', x: 1430 + nb[2] + 8 }]);

        /* y 672: "Average 41 mph" and "35 35 / 38 38 psi" (the words, "/" and "psi" are art) */
        const f = ctx.fonts && ctx.fonts[P.rows.sub672.f];
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        const slot = (i) => 1610 + widthOf(f, '35 35 / 38 38 '.slice(0, [0, 3, 8, 11][i]));
        put('sub672', [{ s: num(sig.avgKmh, 1 / MI) + ' mph', x: 350 + widthOf(f, 'Average ') }]
            .concat([0, 1, 2, 3].map((i) => ({ s: num(ty(i).bar, PSI), x: slot(i) }))));
    },
};
