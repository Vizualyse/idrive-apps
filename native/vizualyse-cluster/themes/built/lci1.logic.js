// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// lci1 "LCI inspired 1": the LCI Sport mockup's behaviour on the theme's
// layers. Speed climbs the left side of the hexagon as an ice band with a
// white trace, a tint and a needle; revs climb the right side in red; scale
// numerals turn white as the band reaches them; shift lights close on the centre
// (white, amber, red) and flash red at the shift point with the rev band
// flashing pale and the gear box outlined red; the upshift chevrons come
// first. UK units (mph, miles, psi, deg C). A reading the source does not
// give shows "--"; nothing is made up. Readouts other than speed and gear
// change ten times a second, as in the mockup.
'use strict';
const MPH = 0.621371, PSI = 14.5038;

const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const alpha = (c, a) => c.slice(0, 3).concat([a]);

/* Several readings in one text layer: [{ s, x (screen px), align }], laid
 * out with the font's advances (params.fonts, measured as the build does). */
function place(p, layer, items) {
    const L = p.text[layer], F = p.fonts[L.font];
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    const codes = [], pos = [];
    items.forEach((it) => {
        const s = String(it.s);
        let w = 0;
        const cs = s.split('').map((ch) => { const c = F.glyphs.indexOf(ch); return c < 0 ? blank : c; });
        cs.forEach((c) => { w += F.adv[c]; });
        let x = it.x - L.x - (it.align === 'right' ? w : it.align === 'center' ? w / 2 : 0);
        cs.forEach((c) => { if (codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += F.adv[c]; });
    });
    /* ascending left edges (the shader takes the last glyph left of a pixel) */
    const order = codes.map((c, i) => i).sort((a, b) => pos[a] - pos[b]);
    const u_text = [], u_pos = [];
    for (let i = 0; i < 16; i++) {
        if (i < order.length) { u_text.push(codes[order[i]]); u_pos.push(pos[order[i]]); } else { u_text.push(blank); u_pos.push(100000); }
    }
    return { uniforms: { u_text, u_pos, u_meta: [L.w, F.glyphs.length, F.cellW, order.length] } };
}
function widthOf(p, font, s) {
    const F = p.fonts[font];
    return String(s).split('').reduce((n, ch) => n + F.adv[Math.max(0, F.glyphs.indexOf(ch) < 0 ? F.glyphs.indexOf(' ') : F.glyphs.indexOf(ch))], 0);
}
/* A horizontal bar drawn as a row of lights (leds.frag), w x h px, lit from
 * x0 to x1 (px in the layer, either way): every light on, those outside the
 * stretch in a transparent colour. cell: the lights' pitch, light: their
 * width (narrower than the pitch: stripes). */
const NONE = [0, 0, 0, 0];
function hbar(w, h, x0, x1, cell, light, color) {
    const n = Math.max(1, Math.round(w / cell)), c = w / n;
    const a = Math.round(Math.min(x0, x1) / c), b = Math.round(Math.max(x0, x1) / c);
    return { uniforms: { u_led: [n, n, 0, 0], u_geom: [w, h, light, h], u_split: [a, b, 0, 0], u_c0: NONE, u_c1: color, u_c2: NONE } };
}
/* how far along the numerals' path they are lit: up to the last one reached */
function litTo(map, v, slack) {
    if (!ok(v)) return 0;
    let lo = 0;
    map.forEach((m) => { if (v >= m[0] - slack) lo = m[1]; });
    return lo;
}

module.exports = {
    update(sig, ctx) {
        const p = ctx.params, C = p.colors, st = ctx.state, core = ctx.core, A = p.at;
        const sp = (k, w) => (st[k] = st[k] || new core.Spring(w));
        const mph = sp('mph', 14).step(ok(sig.kmh) ? sig.kmh * MPH : null, ctx.dt);
        const rpm = sp('rpm', 18).step(sig.rpm, ctx.dt);
        let out = {};

        /* the two slanted scales */
        const side = (pre, v, max, litMap, slack, bandCol) => {
            const has = ok(v), f = has ? clamp(v / max, 0, 1) : 0, on = f > 0.002;
            out[pre + 'Tint'] = { value: core.scale(f, p.traceMap), glow: alpha(C.text, on ? 4 : 0),
                color: alpha(pre === 'speed' ? C.ice : C.redTint, on ? (pre === 'speed' ? 0.38 : 0.94) : 0) };
            const bv = Math.max(p.bandStart, Math.min(p.bandMax, core.scale(f, p.bandMap)));
            /* round the side point the needle fans out with the radius: narrower there */
            const k = clamp(Math.min(bv - p.corner[0], p.corner[1] - bv) / 0.012 + 1, 0, 1);
            out[pre + 'Band'] = { value: bv, color: alpha(bandCol, on ? 1 : 0), needle: alpha(C.text, has ? 1 : 0),
                uniforms: { u_shape: [1, 3.5 + (p.cornerNeedle - 3.5) * k, 0, 0] } };
            out[pre + 'Num'] = { value: litTo(litMap, v, slack) };
        };

        /* shift lights: from 4,600 rpm under power, nine steps to 6,000, then all
         * flashing red at 2.5 Hz with the rev band pale and the gear box red */
        const pulling = !ok(sig.throttle) || sig.throttle > 0.5;
        const now = ok(rpm) && pulling && rpm >= p.shiftAt;
        const blink = Math.floor(ctx.t * 5) % 2 === 0;
        const lit = ok(rpm) && pulling ? clamp(Math.ceil((rpm - p.shiftFrom) / (p.shiftAt - p.shiftFrom) * 9), 0, 9) : 0;
        out.shift = now ? (blink ? { lit: 9, flash: 1, uniforms: { u_off: C.track } } : { lit: 0, flash: 0, uniforms: { u_off: C.redDark } })
            : { lit, flash: 0, uniforms: { u_off: C.track } };

        side('speed', mph, p.maxMph, p.litMph, 0.5, C.ice);
        side('tach', rpm, p.maxRpm, p.litRpm, 20, now && blink ? C.pale : C.red);

        out.gearOutline = { color: alpha(C.red, now ? 1 : 0) };
        out.chevrons = { color: alpha(C.red, ok(rpm) && pulling && rpm >= p.upCue ? 1 : 0) };

        /* speed and gear, every tick */
        out.speedText = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        const mode = sig.gearMode, g = sig.gear;
        const gs = ok(g) ? (g === 0 ? 'N' : String(g)) : '--';
        out.modeMask = { visible: mode !== 'M' };
        if (mode === 'M') out.gearText = place(p, 'gearText', [{ s: gs, x: A.gearM }]);
        else if (/^[PRN]$/.test(mode || '')) out.gearText = place(p, 'gearText', [{ s: mode, x: A.gearMid, align: 'center' }]);
        else if (/^[DS]$/.test(mode || '')) out.gearText = place(p, 'gearText', [{ s: mode + (ok(g) && g > 0 ? g : ''), x: A.gearMid, align: 'center' }]);
        else out.gearText = place(p, 'gearText', [{ s: gs, x: A.gearMid, align: 'center' }]);

        /* bars and the g dot follow every tick */
        const P = p.power;
        const eng = sp('eng', 12).step(sig.engineHp, ctx.dt), ele = sp('ele', 12).step(sig.elecHp, ctx.dt);
        const boost = sp('boost', 10).step(sig.boostBar, ctx.dt);
        const bv = ok(boost) ? clamp(boost / P.boostMax, 0, 1) : 0;
        out.boostBar = hbar(160, 6, 0, bv * 160, 2, 2, C.text);
        const ev = ok(eng) ? clamp(eng / P.engMaxHp, 0, 1) : 0;
        out.engBar = hbar(220, 8, 220 * (1 - ev), 220, 2, 2, C.text);
        /* recovering: the bar in stripes (the mockup's are slanted) */
        const lv = ok(ele) ? clamp(Math.abs(ele) / P.eleMaxHp, 0, 1) : 0, regen = ok(ele) && ele < -1;
        out.eleBar = regen ? hbar(220, 8, 0, lv * 220, P.regenCell, P.regenCell / 2, C.ice) : hbar(220, 8, 0, lv * 220, 2, 2, C.ice);

        const B = p.bars, barV = (k) => (ok(k) ? clamp(Math.max(p.fuelMin, k), 0, 1) * B.bar / B.len : 0);
        out.fuelBar = { value: barV(ok(sig.fuelPct) ? sig.fuelPct / 100 : null), color: alpha(C.text, ok(sig.fuelPct) ? 1 : 0) };
        out.batBar = { value: 1 - barV(ok(sig.socPct) ? sig.socPct / 100 : null), color: alpha(C.ice, ok(sig.socPct) ? 1 : 0) };
        out.oilBar = { value: barV(ok(sig.oilC) ? (sig.oilC - 50) / 100 : null),
            color: alpha(ok(sig.oilC) && sig.oilC > p.oilRed ? C.red : C.text, ok(sig.oilC) ? 1 : 0) };
        out.coolBar = { value: 1 - barV(ok(sig.coolantC) ? (sig.coolantC - 40) / 80 : null),
            color: alpha(ok(sig.coolantC) && sig.coolantC > p.coolRed ? C.red : C.text, ok(sig.coolantC) ? 1 : 0) };

        const G = p.gRing;
        const gx = sp('gx', 10).step(sig.gLat, ctx.dt), gy = sp('gy', 10).step(sig.gLon, ctx.dt);
        out.gDot = ok(gx) && ok(gy) ? { visible: true, x: G.cx - 6 + clamp(gx / G.max, -1, 1) * G.r, y: G.cy - 6 + clamp(gy / G.max, -1, 1) * G.r } : { visible: false };

        /* the rest ten times a second */
        const slot = Math.floor(ctx.t * 10);
        if (st.slot === slot && st.slow) return Object.assign(out, st.slow);
        st.slot = slot;
        const all = out;
        out = {};

        const engS = ok(eng) ? String(Math.round(Math.max(0, eng))) : '--';
        const er = ok(ele) ? Math.round(ele) : null;
        const eleS = er == null ? '--' : (er < 0 ? '−' : '') + Math.abs(er);
        const gv = ok(sig.gLat) && ok(sig.gLon) ? Math.sqrt(sig.gLat * sig.gLat + sig.gLon * sig.gLon).toFixed(1) : '--';
        out.val160 = place(p, 'val160', [{ s: ok(boost) ? Math.max(0, boost).toFixed(1) : '--', x: A.boost }, { s: gv, x: A.gEnd, align: 'right' }]);
        out.val156 = place(p, 'val156', [{ s: engS, x: A.engEnd, align: 'right' }, { s: eleS, x: A.ele }]);
        out.eleUnit = place(p, 'eleUnit', [{ s: 'hp', x: A.ele + widthOf(p, 'val', eleS) + 6 }]);
        out.eleLabel = { text: er != null && er < -1 ? 'RECOVERING' : 'ELECTRIC' };
        const sys = ok(eng) && er != null ? String(Math.max(0, Math.round(Math.max(0, eng)) + Math.max(0, er))) : '--';
        const wA = widthOf(p, 'sub', 'System '), wN = widthOf(p, 'v24', sys), wB = widthOf(p, 'sub', ' hp');
        const x0 = A.sysMid - (wA + wN + wB) / 2;
        out.sysWords = place(p, 'sysWords', [{ s: 'System', x: x0 }, { s: 'hp', x: x0 + wA + wN + widthOf(p, 'sub', ' ') }]);
        out.sysNum = place(p, 'sysNum', [{ s: sys, x: x0 + wA }]);

        /* tyres FL FR RL RR: psi, temperature; the block ice when cold, amber when hot */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        const psi = (i) => num(ty(i).bar, PSI);
        const tc = (i) => (ok(ty(i).c) ? Math.round(ty(i).c) + ' °C' : '-- °C');
        out.psiF = place(p, 'psiF', [{ s: psi(0), x: A.psiFLEnd, align: 'right' }, { s: psi(1), x: A.psiFR }]);
        out.psiR = place(p, 'psiR', [{ s: psi(2), x: A.psiRLEnd, align: 'right' }, { s: psi(3), x: A.psiRR }]);
        out.tempF = place(p, 'tempF', [{ s: tc(0), x: A.tempLEnd, align: 'right' }, { s: tc(1), x: A.tempR }]);
        out.tempR = place(p, 'tempR', [{ s: tc(2), x: A.tempLEnd, align: 'right' }, { s: tc(3), x: A.tempR }]);
        const tyreCol = (i) => { const c = ty(i).c; return !ok(c) ? C.tyre : c < p.tyre.cold ? C.ice : c > p.tyre.hot ? C.amber : C.tyre; };
        out.tyresF = { uniforms: { u_c0: tyreCol(0), u_c1: tyreCol(1) } };
        out.tyresR = { uniforms: { u_c0: tyreCol(2), u_c1: tyreCol(3) } };

        /* fluids and charge beside their bars; ranges in miles */
        out.fluids = place(p, 'fluids', [{ s: num(sig.fuelPct), x: A.fuelEnd, align: 'right' }, { s: num(sig.socPct), x: A.batEnd, align: 'right' },
            { s: num(sig.oilC), x: A.oilEnd, align: 'right' }, { s: num(sig.coolantC), x: A.coolEnd, align: 'right' }]);
        out.ranges = place(p, 'ranges', [{ s: num(sig.rangeKm, MPH) + ' mi', x: A.rangeFuel }, { s: num(sig.evRangeKm, MPH) + ' mi', x: A.rangeBat }]);

        /* corners */
        out.clock = { text: sig.clock ? String(sig.clock) : '--:--' };
        const oc = sig.outsideC;
        out.outside = place(p, 'outside', [{ s: ok(oc) ? (oc < 0 ? '−' : '+') + Math.abs(oc).toFixed(1) + ' °C' : '-- °C', x: A.outside }]);
        let odo = '--';
        if (ok(sig.odoKm)) { const m = Math.floor(sig.odoKm * MPH); odo = (m >= 1000 ? Math.floor(m / 1000) + ' ' + String(m % 1000).padStart(3, '0') : String(m)); }
        out.odo = place(p, 'odo', [{ s: odo + ' mi', x: A.odoEnd, align: 'right' }]);
        st.slow = out;
        return Object.assign(all, out);
    },
};
