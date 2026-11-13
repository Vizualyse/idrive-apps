// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// tri1c "Three-dial 1 · Comfort": the three-ring Comfort mockup's behaviour.
// Centre: a 0-160 mph speedometer, its ribs lit to the speed, the needle,
// the limit arc and the cruise set mark outside the bezel; limit sign,
// D + gear, set speed, speed, rpm (or "Electric"), total range. Left:
// engine load and electric on the bezel arcs (electric green and filling
// from the top while charging), average and current mpg, coolant, average
// speed, trip. Right: fuel and battery arcs, the next turn, road, ranges.
// UK units (mph, miles, yards, mpg, psi, °C). A reading the source doesn't
// give shows "--"; nothing is made up. Nothing flashes.
'use strict';
const MPH = 0.621371, PSI = 14.5038, MPG = 282.481, YD = 1.09361;
const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const grp = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const avg2 = (a, b) => (ok(a) && ok(b) ? (a + b) / 2 : null);

const width = (fonts, font, s) => {
    const F = fonts[font];
    return String(s).split('').reduce((n, c) => n + (F.adv[Math.max(0, F.glyphs.indexOf(c))] || 0), 0);
};
/* a layer the logic lays out: each string at its anchor (or at xs[i], px on screen, when given) */
function lay(p, fonts, name, strs, xs) {
    const L = p.lay[name], F = fonts[L.font];
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    const codes = [], pos = [];
    strs.forEach((s, i) => {
        const a = L.anchors[i];
        const ax = xs && xs[i] != null ? xs[i] - L.x : a.x;
        const cs = String(s).split('').map((c) => { const k = F.glyphs.indexOf(c); return k < 0 ? blank : k; });
        const w = cs.reduce((n, c) => n + F.adv[c], 0);
        let x = a.align === 'right' ? ax - w : a.align === 'center' ? ax - w / 2 : ax;
        cs.forEach((c) => { if (codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += F.adv[c]; });
    });
    const n = codes.length;
    for (let i = n; i < 16; i++) { codes.push(blank); pos.push(100000); }
    return { uniforms: { u_text: codes, u_pos: pos, u_meta: [L.w, F.glyphs.length, F.cell[0], n] } };
}

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core;
        st.mph = st.mph || new core.Spring(12);
        st.eng = st.eng || new core.Spring(8);
        st.el = st.el || new core.Spring(8);
        const mph = st.mph.step(ok(sig.kmh) ? sig.kmh * MPH : null, ctx.dt);
        const eng = st.eng.step(sig.engineHp, ctx.dt), el = st.el.step(sig.elecHp, ctx.dt);
        const out = {};
        const a = (c, al) => [c[0], c[1], c[2], al];
        const len = p.len.ribs, half = p.vmax / 2;
        /* a mark at mph on either half: t from the top, negative past it */
        const halves = (v) => { const tr = clamp(v, 0, p.vmax) / half - 1; return [-tr, tr]; };

        /* the speed band and needle (as tri1's rev band, without a red zone) */
        if (ok(mph)) {
            const tl = 1 - mph / half, tr = mph / half - 1;
            out.ribsL = { needle: C.ink, uniforms: { u_v: [tl, len, 2, 0], u_seg: [0, 0, Math.min(0, tl), 1] } };
            out.ribsR = { needle: C.ink, uniforms: { u_v: [tr, len, 2, 0], u_seg: [0, 0, 1, 1] } };
        } else {
            out.ribsL = { needle: a(C.ink, 0), uniforms: { u_v: [1, len, 2, 0], u_seg: [0, 0, 0, 1] } };
            out.ribsR = { needle: a(C.ink, 0), uniforms: { u_v: [0, len, 2, 0], u_seg: [0, 0, 1, 1] } };
        }
        /* the limit arc and the set mark: each half drawn only when the mark is in it */
        const mark = (name, v, deg) => {
            if (!ok(v)) { out[name + 'L'] = { visible: false }; out[name + 'R'] = { visible: false }; return; }
            const h = halves(v), m = deg / 135;
            out[name + 'L'] = { visible: h[0] > -m, uniforms: { u_v: [h[0], len, 2, 0] } };
            out[name + 'R'] = { visible: h[1] > -m, uniforms: { u_v: [h[1], len, 2, 0] } };
        };
        const limit = ok(sig.limitKmh) ? Math.round(sig.limitKmh * MPH) : null;
        const cruise = ok(sig.cruiseKmh) ? Math.round(sig.cruiseKmh * MPH) : null;
        mark('limit', limit, p.limitDeg);
        mark('set', cruise, p.setDeg);

        /* centre readouts */
        out.speed = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        out.limit = { text: limit == null ? '--' : String(limit) };
        out.set = cruise == null ? { text: '– –', color: C.line } : { text: String(cruise), color: C.ink };
        const g = sig.gear;
        out.mode = { text: typeof sig.gearMode === 'string' && sig.gearMode ? sig.gearMode.slice(0, 1) : '-' };
        out.gear = { text: !ok(g) ? '--' : g === 0 ? 'N' : g < 0 ? 'R' : String(g) };
        const ev = ok(sig.rpm) && sig.rpm < 300;
        out.rpm = Object.assign(lay(p, ctx.fonts, 'rpm', ev ? ['', 'Electric'] : [ok(sig.rpm) ? grp(Math.round(sig.rpm / 50) * 50) : '--', '']),
            { color: ev ? C.elec : C.ink2 });
        out.rpmUnit = { text: ev ? '' : 'rpm' };
        out.range = { text: ok(sig.rangeKm) && ok(sig.evRangeKm) ? String(Math.round((sig.rangeKm + sig.evRangeKm) * MPH)) : '--' };

        /* corners */
        out.clock = { text: typeof sig.clock === 'string' && sig.clock ? sig.clock : '--:--' };
        out.outside = { text: ok(sig.outsideC) ? String(Math.round(sig.outsideC)).replace(/^-/, '−') : '--' };
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        /* front / rear, each the pair's mean; "Tyres" and the pressures as two runs (16 glyphs a layer) */
        out.tyres = lay(p, ctx.fonts, 'tyres', ['Tyres', num(avg2(ty(0).bar, ty(1).bar), PSI) + ' / ' + num(avg2(ty(2).bar, ty(3).bar), PSI) + ' psi'],
            [null, 150 + width(ctx.fonts, 'small', 'Tyres ')]);
        const togo = '· ' + num(sig.destKm, MPH) + ' mi';
        out.togo = { text: togo };
        out.arrive = lay(p, ctx.fonts, 'arrive', ['Arrive ' + (typeof sig.eta === 'string' && sig.eta ? sig.eta : '--:--')],
            [1770 - width(ctx.fonts, 'small', togo) - width(ctx.fonts, 'small', ' ')]);

        /* left ring: economy */
        out.eng = { value: ok(eng) ? clamp(eng / p.engMaxHp, 0, 1) : 0 };
        const chg = ok(el) && el < -1;
        const f = ok(el) ? clamp(Math.abs(el) / p.elMaxHp, 0, 1) : 0;
        /* driving fills up from the bottom stop; charging down from the top stop, green */
        out.elec = chg ? { color: C.charge, uniforms: { u_v: [1 - f, 0, 2, 0], u_seg: [0, 0, 1, 1] } }
            : { color: C.elec, uniforms: { u_v: [f, 0, 2, 0], u_seg: [0, 0, 0, 1] } };
        out.elec.uniforms.u_v[1] = p.len.arc;
        const pct = ok(el) ? Math.round(f * 100) : null;
        out.elV = { text: pct == null ? '--' : String(pct), color: pct == null || pct === 0 ? C.ink2 : chg ? C.charge : C.elec };
        out.elLabel = { text: !ok(el) ? 'Electric' : chg ? 'Charging' : ok(eng) && eng < 1 ? 'Drive' : 'Assist' };
        out.avg = { text: ok(sig.avgL100) && sig.avgL100 > 0 ? (MPG / sig.avgL100).toFixed(1) : '--' };
        const inst = sig.instL100;
        out.now = { text: !ok(inst) ? '--' : inst < 0.1 || MPG / inst > 99 ? '99+' : String(Math.round(MPG / inst)) };
        out.row = lay(p, ctx.fonts, 'row', [num(sig.coolantC), num(sig.avgKmh, MPH), ok(sig.tripKm) ? (sig.tripKm * MPH).toFixed(1) : '--']);

        /* right ring: the next turn, ranges */
        const m = sig.turnM;
        let dist = '--', unit = '';
        if (ok(m)) {
            if (m * MPH / 1000 > 0.5) { dist = (m / 1609.344).toFixed(1); unit = 'mi'; }
            else { dist = String(Math.max(50, Math.round(m * YD / 50) * 50)); unit = 'yd'; }
        }
        /* a right turn's arrow is the left one mirrored about its stem: the distance moves past it */
        const dx = sig.turnDir === 'right' ? p.turnShift : 0;
        out.dist = { text: dist, x: p.distX + dx };
        out.distUnit = lay(p, ctx.fonts, 'distUnit', [unit], [1528 + dx + width(ctx.fonts, 'val', dist) + 5]);
        out.turnCover = { x: sig.turnDir === 'left' ? p.turnCover.left : sig.turnDir === 'right' ? p.turnCover.right : p.turnCover.none };
        out.road = { text: typeof sig.road === 'string' && sig.road ? sig.road.slice(0, 16) : '--' };
        out.fuel = { value: ok(sig.fuelPct) ? clamp(sig.fuelPct / 100, 0, 1) : 0 };
        out.bat = { value: ok(sig.socPct) ? clamp(sig.socPct / 100, 0, 1) : 0 };
        out.fuelRange = { text: num(sig.rangeKm, MPH) };
        out.fuelLabel = { text: 'Fuel ' + num(sig.fuelPct) + ' %' };
        out.batRange = { text: num(sig.evRangeKm, MPH) };
        out.batLabel = { text: 'Battery ' + num(sig.socPct) + ' %' };
        return out;
    },
};
