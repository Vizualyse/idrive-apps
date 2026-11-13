// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// lci1c "LCI inspired 1 · Comfort": the LCI Comfort mockup's behaviour on the
// theme's layers. Speed climbs the left side of the hexagon in ice, revs the
// right side in pale blue; scale numerals turn white as the band reaches
// them; the cruise set speed is an ice mark outside the speed band; the meter
// grows from its zero tick into charge (striped), eco and power, its zone
// named in white; limit and cruise top left, the next turn top right, the
// arrival line under the map area, range and fluids in the lower wings.
// Nothing blinks. UK units (mph, miles, mpg, deg C, psi). A reading the
// source does not give shows "--"; nothing is made up. Readouts other than
// speed and gear change ten times a second, as in the mockup.
'use strict';
const MPH = 0.621371, PSI = 14.5038, MPG = 282.481, YD = 1.09361;

const ok = (v) => v != null && isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, f) => (ok(v) ? String(Math.round(f ? v * f : v)) : '--');
const alpha = (c, a) => c.slice(0, 3).concat([a]);
const NONE = [0, 0, 0, 0];

/* Several readings in one text layer: [{ s, x (screen px), align }], laid
 * out with the font's advances (params.fonts, measured as the build does). */
function place(p, layer, items) {
    const L = p.text[layer], F = p.fonts[L.font];
    const blank = Math.max(0, F.glyphs.indexOf(' '));
    const codes = [], pos = [];
    items.forEach((it) => {
        const cs = String(it.s).split('').map((ch) => { const c = F.glyphs.indexOf(ch); return c < 0 ? blank : c; });
        const w = cs.reduce((n, c) => n + F.adv[c], 0);
        let x = it.x - L.x - (it.align === 'right' ? w : it.align === 'center' ? w / 2 : 0);
        cs.forEach((c) => { if (codes.length < 16) { codes.push(c); pos.push(Math.round(x)); } x += F.adv[c]; });
    });
    const order = codes.map((c, i) => i).sort((a, b) => pos[a] - pos[b]);
    const u_text = [], u_pos = [];
    for (let i = 0; i < 16; i++) {
        if (i < order.length) { u_text.push(codes[order[i]]); u_pos.push(pos[order[i]]); } else { u_text.push(blank); u_pos.push(100000); }
    }
    return { uniforms: { u_text, u_pos, u_meta: [L.w, F.glyphs.length, F.cellW, order.length] } };
}
function widthOf(p, font, s) {
    const F = p.fonts[font], blank = Math.max(0, F.glyphs.indexOf(' '));
    return String(s).split('').reduce((n, ch) => { const c = F.glyphs.indexOf(ch); return n + F.adv[c < 0 ? blank : c]; }, 0);
}
/* a horizontal bar as a row of lights, lit from x0 to x1 (px in the layer) */
function hbar(w, h, x0, x1, cell, light, color) {
    const n = Math.max(1, Math.round(w / cell)), c = w / n;
    const a = Math.round(Math.min(x0, x1) / c), b = Math.round(Math.max(x0, x1) / c);
    return { uniforms: { u_led: [n, n, 0, 0], u_geom: [w, h, light, h], u_split: [a, b, 0, 0], u_c0: NONE, u_c1: color, u_c2: NONE } };
}
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
        const mph = sp('mph', 12).step(ok(sig.kmh) ? sig.kmh * MPH : null, ctx.dt);
        const rpm = sp('rpm', 14).step(sig.rpm, ctx.dt);
        const pale = [0.788, 0.847, 1, 1];
        let out = {};

        /* the two slanted scales */
        const side = (pre, v, max, litMap, slack, bandCol, tintCol, tintA, needleOn) => {
            const has = ok(v), f = has ? clamp(v / max, 0, 1) : 0, on = f > 0.002;
            out[pre + 'Tint'] = { value: core.scale(f, p.traceMap), glow: alpha(pre === 'speed' ? C.text : [0.47, 0.39, 0.13], on ? 4 : 0),
                color: alpha(tintCol, on ? tintA : 0) };
            const bv = Math.max(p.bandStart, Math.min(p.bandMax, core.scale(f, p.bandMap)));
            const k = clamp(Math.min(bv - p.corner[0], p.corner[1] - bv) / 0.012 + 1, 0, 1);
            out[pre + 'Band'] = { value: bv, color: alpha(bandCol, on ? 1 : 0), needle: alpha(C.text, has && needleOn ? 1 : 0),
                uniforms: { u_shape: [1, 3.5 + (p.cornerNeedle - 3.5) * k, 0, 0] } };
            out[pre + 'Num'] = { value: litTo(litMap, v, slack) };
        };
        side('speed', mph, p.maxMph, p.litMph, 0.5, C.ice, C.ice, 0.26, true);
        /* revs: numerals light only with the engine turning; the needle hides below 60 rpm */
        side('tach', ok(rpm) && rpm > 100 ? rpm : (ok(rpm) ? 0 : null), p.maxRpm, p.litRpm, 20, pale, pale, 0.2, ok(rpm) && rpm > 60);

        /* cruise set speed: the mark outside the speed band */
        const cruise = ok(sig.cruiseKmh) ? sig.cruiseKmh * MPH : null;
        out.setMark = cruise != null ? { value: core.scale(clamp(cruise / p.maxMph, 0, 1), p.markMap), needle: alpha(C.ice, 1) } : { needle: alpha(C.ice, 0) };

        /* speed and gear, every tick */
        out.speedText = { text: ok(mph) ? String(Math.round(mph)) : '--' };
        const mode = sig.gearMode, g = sig.gear;
        const inD = mode === 'D' || mode == null;
        out.modeMask = { visible: !inD };
        out.modeText = place(p, 'modeText', inD ? [] : [{ s: mode || '-', x: A.dX }]);
        out.gearDigit = place(p, 'gearDigit', /^[PRN]$/.test(mode || '') ? [] : [{ s: ok(g) && g > 0 ? String(g) : '--', x: A.gear }]);

        /* the meter: charge left of the zero tick, eco then power right of it */
        const M = p.meter;
        const eng = sp('eng', 10).step(sig.engineHp, ctx.dt), ele = sp('ele', 10).step(sig.elecHp, ctx.dt);
        let pw = null;
        if (ok(ele) && ele < -1) pw = Math.max(-0.9, ele / M.regenHp);
        else if (ok(eng) || ok(ele)) pw = Math.min(0.95, (Math.max(0, eng || 0) + Math.max(0, ele || 0)) / M.sysHp);
        const px = pw == null ? M.zero : pw < 0 ? M.zero + pw * 110 : pw <= M.ecoTo ? M.zero + pw * 400 : 1080 + (pw - M.ecoTo) * 275;
        const regen = pw != null && pw < -0.01;
        const mcol = regen ? C.ice : ok(eng) && eng > 0.5 ? C.text : C.ice;
        out.meter = regen ? hbar(M.w, 8, M.zero - M.x, px - M.x, M.regenCell, M.regenCell / 2, mcol) : hbar(M.w, 8, M.zero - M.x, px - M.x, 2, 2, mcol);

        /* the rest ten times a second */
        const slot = Math.floor(ctx.t * 10);
        if (st.slot === slot && st.slow) return Object.assign(out, st.slow);
        st.slot = slot;
        const all = out;
        out = {};

        out.zones = place(p, 'zones', pw == null ? [] : pw < -0.03 ? [{ s: 'CHARGE', x: A.zoneCharge, align: 'center' }]
            : pw > M.ecoTo ? [{ s: 'POWER', x: A.zonePower, align: 'center' }] : [{ s: 'ECO', x: A.zoneEco, align: 'center' }]);

        /* average and on-electric, the unit after the second */
        const avg = ok(sig.avgL100) && sig.avgL100 > 0 ? (MPG / sig.avgL100).toFixed(1) : '--';
        const ev = ok(sig.evTripKm) ? (sig.evTripKm * MPH).toFixed(1) : '--';
        out.avgEv = place(p, 'avgEv', [{ s: avg, x: A.avgEnd, align: 'right' }, { s: ev, x: A.ev }]);
        out.evUnit = place(p, 'evUnit', [{ s: 'mi', x: A.ev + widthOf(p, 'val', ev) + 6 }]);

        /* arrival: "Arrive 16:12   23.0 mi to go", centred */
        const eta = sig.eta ? String(sig.eta) : '--:--', togo = ok(sig.destKm) ? (sig.destKm * MPH).toFixed(1) : '--';
        const wA = widthOf(p, 'sub', 'Arrive '), wE = widthOf(p, 'v24', eta), wD = widthOf(p, 'v24', togo), wT = widthOf(p, 'sub', ' mi to go');
        const x0 = A.arriveMid - (wA + wE + 22 + wD + wT) / 2;
        out.arriveWords = place(p, 'arriveWords', [{ s: 'Arrive', x: x0 }, { s: 'mi to go', x: x0 + wA + wE + 22 + wD + widthOf(p, 'sub', ' ') }]);
        out.arriveNums = place(p, 'arriveNums', [{ s: eta, x: x0 + wA }, { s: togo, x: x0 + wA + wE + 22 }]);

        /* limit and cruise */
        out.limitText = place(p, 'limitText', [{ s: ok(sig.limitKmh) ? String(Math.round(sig.limitKmh * MPH / 5) * 5) : '--', x: A.limitMid, align: 'center' }]);
        const cs = cruise != null ? String(Math.round(cruise)) : '--';
        out.cruiseVal = Object.assign(place(p, 'cruiseVal', [{ s: cs, x: A.cruise }]), { color: cruise != null ? C.text : C.text2 });
        out.cruiseUnit = place(p, 'cruiseUnit', cruise != null ? [{ s: 'mph', x: A.cruise + widthOf(p, 'val', cs) + 6 }] : []);

        /* the next turn: label, distance (yards under a quarter mile), road, the arrow */
        const dir = sig.turnDir === 'left' || sig.turnDir === 'right' ? sig.turnDir : null;
        out.manLabel = place(p, 'manLabel', [{ s: dir ? 'TURN ' + dir.toUpperCase() : '--', x: A.manEnd, align: 'right' }]);
        let ds = '--', du = '';
        if (ok(sig.turnM)) {
            if (sig.turnM < 402) { ds = String(Math.max(10, Math.round(sig.turnM * YD / 10) * 10)); du = 'yd'; }
            else { ds = (sig.turnM / 1609.344).toFixed(1); du = 'mi'; }
        }
        const wU = du ? widthOf(p, 'label', du) + 6 : 0;
        out.manUnit = place(p, 'manUnit', du ? [{ s: du, x: A.manEnd, align: 'right' }] : []);
        out.manDist = place(p, 'manDist', [{ s: ds, x: A.manEnd - wU, align: 'right' }]);
        out.manRoad = place(p, 'manRoad', [{ s: sig.road ? String(sig.road).slice(0, 16) : '--', x: A.roadEnd, align: 'right' }]);
        out.arrowL = { visible: dir !== 'left' };
        out.arrowR = { visible: dir !== 'right' };
        out.arrowStem = { visible: !dir };

        /* range and fluids beside their bars */
        const B = p.bars, barV = (k) => (ok(k) ? clamp(Math.max(p.fuelMin, k), 0, 1) * B.bar / B.len : 0);
        const ins = ok(sig.instL100) ? (sig.instL100 > 0 ? Math.min(p.mpgMax, MPG / sig.instL100) : p.mpgMax) : null;
        const electric = ok(eng) && eng <= 0.5 && ok(rpm) && rpm < 100;
        out.fuelBar = { value: barV(ok(sig.fuelPct) ? sig.fuelPct / 100 : null), color: alpha(C.text, ok(sig.fuelPct) ? 1 : 0) };
        out.batBar = { value: 1 - barV(ok(sig.socPct) ? sig.socPct / 100 : null), color: alpha(C.ice, ok(sig.socPct) ? 1 : 0) };
        out.coolBar = { value: barV(ok(sig.coolantC) ? (sig.coolantC - 40) / 80 : null),
            color: alpha(ok(sig.coolantC) && sig.coolantC > p.coolRed ? C.red : C.text, ok(sig.coolantC) ? 1 : 0) };
        out.mpgBar = { value: 1 - barV(electric ? 1 : ins != null ? ins / p.mpgMax : null), color: alpha(electric ? C.ice : C.text, electric || ins != null ? 1 : 0) };
        out.mpgUnitMask = { visible: electric };
        out.fluids = place(p, 'fluids', [{ s: num(sig.rangeKm, MPH), x: A.fuelEnd, align: 'right' }, { s: num(sig.evRangeKm, MPH), x: A.batEnd, align: 'right' },
            { s: num(sig.coolantC), x: A.coolEnd, align: 'right' }, { s: electric ? '--' : ins != null ? String(Math.round(ins)) : '--', x: A.mpgEnd, align: 'right' }]);
        out.percents = place(p, 'percents', [{ s: num(sig.fuelPct) + ' %', x: A.pctFuel }, { s: num(sig.socPct) + ' %', x: A.pctBat }]);

        /* corners: trip and tyres, the clock, outside and the odometer */
        const ty = (i) => (sig.tyres && sig.tyres[i]) || {};
        out.cornerTop = place(p, 'cornerTop', [{ s: ok(sig.tripKm) ? (sig.tripKm * MPH).toFixed(1) + ' mi' : '-- mi', x: A.trip }]
            .concat([0, 1, 2, 3].map((i) => ({ s: num(ty(i).bar, PSI), x: A['t' + i], align: 'center' }))));
        out.clock = { text: sig.clock ? String(sig.clock) : '--:--' };
        const oc = sig.outsideC;
        let odo = '--';
        if (ok(sig.odoKm)) { const m = Math.floor(sig.odoKm * MPH); odo = m >= 1000 ? Math.floor(m / 1000) + ' ' + String(m % 1000).padStart(3, '0') : String(m); }
        out.cornerBot = place(p, 'cornerBot', [{ s: ok(oc) ? (oc < 0 ? '−' : '+') + Math.abs(oc).toFixed(1) + ' °C' : '-- °C', x: A.outside },
            { s: odo, x: A.odoEnd, align: 'right' }]);
        st.slow = out;
        return Object.assign(all, out);
    },
};
