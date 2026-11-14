// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The helpers a design's bindings call (DESIGNS.md "Bindings"). The part
 * between the RUNTIME markers is copied into every logic.js that
 * tools/design_build.js writes, so a built theme needs nothing else; the
 * build requires this file too, to evaluate constant bindings. Node 8 and
 * the browser (the preview) both run it: no syntax past ES2015.
 */
'use strict';
/* RUNTIME START */
const DR = (function () {
    const KM_MI = 1.609344, BAR_PSI = 14.5038;
    const fin = (v) => typeof v === 'number' && isFinite(v);
    const num = (v) => (typeof v === 'number' ? v : v == null ? NaN : typeof v === 'boolean' ? +v : Number(v));

    /* a colour: [r, g, b, a] 0..1 from an array, '#rgb', '#rrggbb', '#rrggbbaa' or 'rgb(a)(...)' */
    function col(v) {
        if (Array.isArray(v)) return v.length === 3 ? v.concat([1]) : v.slice(0, 4);
        if (typeof v !== 'string') return undefined;
        const s = v.trim();
        if (s === 'transparent' || s === 'none') return [0, 0, 0, 0];
        let m = /^#([0-9a-f]{3,8})$/i.exec(s);
        if (m) {
            let h = m[1];
            if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
            if (h.length !== 6 && h.length !== 8) return undefined;
            const o = [];
            for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16) / 255);
            if (o.length === 3) o.push(1);
            return o;
        }
        m = /^rgba?\(([^)]*)\)$/i.exec(s);
        if (m) {
            const p = m[1].split(/[\s,/]+/).filter((x) => x).map(parseFloat);
            return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
        }
        return undefined;
    }

    /* the signals with every null made undefined (arithmetic on a missing
     * reading then gives NaN, which the logic shows as "--" or hides) */
    function undef(v) {
        if (v === null) return undefined;
        if (Array.isArray(v)) return v.map(undef);
        if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = undef(v[k]); }); return o; }
        return v;
    }

    /* a binding's result that means "no reading" */
    function isNull(r) {
        if (r === undefined || r === null) return true;
        if (typeof r === 'number') return !isFinite(r);
        if (typeof r === 'string') return /undefined|NaN/.test(r);
        if (Array.isArray(r)) return r.some((x) => !fin(x));
        return false;
    }

    function fmt(v, d, sign) {
        v = num(v);
        if (!fin(v)) return '--';
        let s = d > 0 ? v.toFixed(d) : String(Math.round(v));
        if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
        if (sign === '+' && s[0] !== '-') s = '+' + s;
        return s;
    }

    function pure() {
        return {
            mph: (kmh) => num(kmh) / KM_MI,
            miles: (km) => num(km) / KM_MI,
            psi: (bar) => num(bar) * BAR_PSI,
            fmt: fmt,
            round: (v, to) => Math.round(num(v) / (to || 1)) * (to || 1),
            clamp: (x, a, b) => { x = num(x); a = a == null ? 0 : a; b = b == null ? 1 : b; return x < a ? a : x > b ? b : x; },
            when: (c, a, b) => (c ? a : b),
            /* step(v, c0, t1, c1, t2, c2, ...): c0 below t1, c1 from t1, c2 from t2 */
            step: function (v) {
                v = num(v);
                if (!fin(v)) return undefined;
                let out = arguments[1];
                for (let i = 2; i + 1 < arguments.length; i += 2) if (v >= arguments[i]) out = arguments[i + 1];
                return out;
            },
            ok: (v) => v != null && (typeof v !== 'number' || isFinite(v)),
            alpha: (c, a) => { const k = col(c); return k ? [k[0], k[1], k[2], num(a)] : undefined; },
            rgb: (r, g, b, a) => [r / 255, g / 255, b / 255, a == null ? 1 : a],
            abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil,
        };
    }
    const STATEFUL = ['smooth', 'latch', 'flash'];

    /* A binding's helpers. B: { slots, i (the next call site), dt, ctx }:
     * each call of a stateful helper in a binding keeps its own state, by the
     * order of the calls (so they must not sit behind ?: or &&; when() is fine). */
    function makeHelpers(B, core) {
        const h = pure();
        /* a critically damped spring (theme_core.Spring); omega about 12-20 */
        h.smooth = (x, omega) => {
            const k = B.i++;
            const s = B.slots[k] || (B.slots[k] = new core.Spring(omega || 14));
            x = num(x);
            if (!fin(x)) { s.x = null; s.v = 0; return NaN; }
            return s.step(x, B.dt);
        };
        /* true from a tick where set is true until one where reset is */
        h.latch = (set, reset) => {
            const k = B.i++;
            let v = !!B.slots[k];
            if (set) v = true;
            if (reset) v = false;
            B.slots[k] = v;
            return v;
        };
        /* true and false in turn, hz times a second, while on (keep it at 3 Hz or less) */
        h.flash = (hz, on) => (on === undefined || on ? Math.floor(B.ctx.t * (hz || 2.5) * 2) % 2 === 0 : false);
        h._t = () => B.ctx.t;
        h._dt = () => B.dt;
        return h;
    }

    /* one binding's evaluation; st keeps each binding's state between ticks */
    function evaluate(st, id, fn, S, L, ctx) {
        const B = st[id] || (st[id] = { slots: [], i: 0, dt: 0, last: null, ctx: null, H: null });
        B.ctx = ctx; B.i = 0;
        B.dt = B.last == null || ctx.t < B.last ? ctx.dt : ctx.t - B.last;
        B.last = ctx.t;
        if (!B.H) B.H = makeHelpers(B, ctx.core);
        try { return fn(S, B.H, L); } catch (e) { return undefined; }
    }

    return { col: col, undef: undef, isNull: isNull, makeHelpers: makeHelpers, evaluate: evaluate,
        NAMES: Object.keys(pure()).concat(STATEFUL), STATEFUL: STATEFUL };
})();
/* RUNTIME END */
module.exports = DR;
