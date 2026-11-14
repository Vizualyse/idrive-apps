// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * What a theme's logic says, turned into uniforms: shared by the tool (which
 * sends them to cluster-render) and the off-car preview (which hands them to
 * WebGL), so both draw from the same numbers. No I/O here; Node 8 and the
 * browser both load it (module.exports, or window.ThemeCore).
 *
 * A built theme (<id>.theme.json) has layers; each effect layer names its
 * shader and starts from the theme's uniforms. Its logic returns, per layer
 * name, any of:
 *   value    gauge: 0..1 along its path
 *   text     text: the string (laid out with the font's advances, aligned)
 *   color    text, rect: [r, g, b, a]; gauge: the band's colour
 *   ring     rect: the ring's colour
 *   glow, needle, red   gauge colours
 *   lit, flash          leds: steps lit; 0 normal, 1 all the flash colour, 2 all off
 *   uniforms            { u_name: [numbers] } for anything else
 *   visible, x, y       the layer's own fields (sent with set)
 */
(function (root) {
    'use strict';

    const LIMITS = { layers: 40, assets: 12, bottom: 646, side: 2048, frame: 5529600, uniformVectors: 12 };

    /* The panel as the car shows it (measured on the car, 2026-11-14:
     * knowledge/cluster-and-hud.md, the photos in docs/). [x, y, w, h].
     *   gearWindow  never drawn: the KOMBI's own gear readout shows through
     *               it. Covering any of the strip there brings up its
     *               fallback gear box (a black box over the rev counter);
     *               all the rest of the strip may be covered.
     *   keepOut     the KOMBI's warning lights and the gear's plate draw over
     *               the panel here: no moving part (text, gauge, lights) in
     *               them, the art only (kept plain).
     *   corners     the glass cuts the top corners on a diagonal: a line
     *               from (0, y) to (x, 0) on the left, (1920 - x, 0) to
     *               (1920, y) on the right; nothing moving above it. */
    const PANEL = {
        gearWindow: [1366, 665, 96, 55],
        keepOut: [
            { what: 'the gear readout', r: [1356, 640, 116, 80] },
            { what: 'the warning lights on the left', r: [0, 200, 120, 270] },
            { what: 'the warning lights at the bottom left', r: [560, 660, 340, 60] },
            { what: 'the parking brake light', r: [1790, 200, 130, 100] }
        ],
        corners: { left: [325, 190], right: [270, 200] }
    };
    function overlaps(a, b) { return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]; }
    /* what of PANEL a rectangle breaks (a list of words, empty when none) */
    function panelProblems(r) {
        const p = [];
        if (overlaps(r, PANEL.gearWindow)) p.push('covers the gear window');
        PANEL.keepOut.forEach((k) => { if (overlaps(r, k.r)) p.push('is over ' + k.what); });
        const L = PANEL.corners.left, R = PANEL.corners.right;
        if (r[0] / L[0] + r[1] / L[1] < 1) p.push('reaches into the top-left corner the glass cuts off');
        if ((1920 - (r[0] + r[2])) / R[0] + r[1] / R[1] < 1) p.push('reaches into the top-right corner the glass cuts off');
        return p;
    }

    /* Text laid out with the font's advances (text.frag version 2): up to 16
     * glyph codes and each glyph's left edge in pixels, aligned in the
     * layer's width. layer: { glyphs, adv (px per glyph, or none: the cell
     * width each), cellW, w, cells, align }. */
    function layoutText(str, layer) {
        let s = String(str == null ? '' : str);
        if (s.length > Math.min(16, layer.cells)) s = s.slice(s.length - Math.min(16, layer.cells));
        const blank = Math.max(0, layer.glyphs.indexOf(' '));
        const codes = [], pos = [];
        const adv = (c) => layer.adv ? layer.adv[c] : layer.cellW;
        let x = 0;
        for (let i = 0; i < s.length; i++) {
            let c = layer.glyphs.indexOf(s[i]);
            if (c < 0) c = blank;
            codes.push(c); pos.push(x); x += adv(c);
        }
        const off = layer.align === 'right' ? layer.w - x : layer.align === 'center' ? (layer.w - x) / 2 : 0;
        for (let i = 0; i < 16; i++) {
            if (i < codes.length) pos[i] = Math.round(pos[i] + off);
            else { codes[i] = blank; pos[i] = 100000; }
        }
        return { codes: codes, pos: pos, count: s.length };
    }

    /* 16 glyph codes for text in a font of glyphs (a string), padded to
     * cells. Unknown characters show as the font's space (or its first
     * glyph). */
    function encodeText(str, glyphs, cells, align) {
        let s = String(str == null ? '' : str);
        if (s.length > cells) s = s.slice(s.length - cells);
        const pad = cells - s.length;
        if (align === 'right') s = ' '.repeat(pad) + s;
        else if (align === 'center') s = ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(pad - Math.floor(pad / 2));
        else s = s + ' '.repeat(pad);
        const blank = Math.max(0, glyphs.indexOf(' '));
        const codes = [];
        for (let i = 0; i < 16; i++) {
            const c = i < s.length ? glyphs.indexOf(s[i]) : blank;
            codes.push(c < 0 ? blank : c);
        }
        return codes;
    }

    /* A critically damped spring: smooth, no overshoot, keeps up with a
     * needle (omega about 12-20 per second). */
    function Spring(omega) { this.x = null; this.v = 0; this.omega = omega || 14; }
    Spring.prototype.step = function (target, dt) {
        if (target == null || !isFinite(target)) return this.x;
        if (this.x === null || !(dt > 0)) { this.x = target; this.v = 0; return this.x; }
        const w = this.omega, n = Math.max(1, Math.ceil(dt / 0.01)), h = dt / n;
        for (let i = 0; i < n; i++) {
            const a = -w * w * (this.x - target) - 2 * w * this.v;
            this.v += a * h;
            this.x += this.v * h;
        }
        return this.x;
    };

    /* Piecewise-linear map of a reading onto 0..1 along a scale:
     * [[reading, position], ...] ascending. */
    function scale(v, map) {
        if (v == null || !isFinite(v)) return null;
        if (v <= map[0][0]) return map[0][1];
        for (let i = 1; i < map.length; i++) {
            if (v <= map[i][0]) {
                const a = map[i - 1], b = map[i];
                return a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]);
            }
        }
        return map[map.length - 1][1];
    }

    function vec4(a, i, v) { const o = a.slice(); o[i] = v; return o; }

    /* A layer's uniforms after the logic's word on it: { name: [numbers] }. */
    function layerUniforms(layer, u, said) {
        const out = {};
        if (!said) return out;
        if (said.uniforms) Object.keys(said.uniforms).forEach((k) => { out[k] = said.uniforms[k]; });
        if (layer.shader === 'gauge') {
            /* value sets u_val.x, on top of a u_val the logic sent in uniforms this tick if it did */
            if (said.value != null && isFinite(said.value)) out.u_val = vec4(out.u_val || u.u_val, 0, Math.max(0, Math.min(1, said.value)));
            if (said.color) out.u_fill = said.color;
            if (said.glow) out.u_glow = said.glow;
            if (said.needle) out.u_needle = said.needle;
            if (said.red) out.u_red = said.red;
        } else if (layer.shader === 'text') {
            if (said.text != null) {
                const l = layoutText(said.text, layer);
                out.u_text = l.codes;
                out.u_pos = l.pos;
                out.u_meta = [layer.w, layer.glyphs.length, layer.cellW, l.count];
            }
            if (said.color) out.u_color = said.color;
        } else if (layer.shader === 'leds') {
            let led = u.u_led;
            if (said.lit != null) led = vec4(led, 1, said.lit);
            if (said.flash != null) led = vec4(led, 2, said.flash);
            if (led !== u.u_led) out.u_led = led;
        } else if (layer.shader === 'rect') {
            if (said.color) out.u_color = said.color;
            if (said.ring) out.u_ring = said.ring;
        }
        return out;
    }

    /* Keeps what was last sent per layer and returns only what changed:
     * [{ layer, uniforms: { name: [..] }, set: { visible, x, y } | null }]. */
    function Differ(theme) {
        this.theme = theme;
        this.last = {};
        theme.layers.forEach((l) => {
            const u = {};
            Object.keys(l.uniforms || {}).forEach((k) => { u[k] = l.uniforms[k].slice(); });
            this.last[l.name] = { uniforms: u, visible: 1, x: l.x, y: l.y };
        });
    }
    Differ.prototype.changes = function (said) {
        const out = [];
        this.theme.layers.forEach((l) => {
            const s = said[l.name];
            if (!s) return;
            const last = this.last[l.name];
            const changed = {};
            let any = false;
            const nu = l.kind === 'effect' ? layerUniforms(l, last.uniforms, s) : {};
            Object.keys(nu).forEach((k) => {
                const v = nu[k].map((x) => Math.round(x * 10000) / 10000);
                const prev = last.uniforms[k];
                if (!prev || prev.length !== v.length || v.some((x, i) => x !== prev[i])) {
                    changed[k] = v;
                    last.uniforms[k] = v;
                    any = true;
                }
            });
            let set = null;
            ['visible', 'x', 'y'].forEach((k) => {
                if (s[k] == null) return;
                /* a text layer whose atlas lost its blank top rows starts dy
                 * lower than the logic's y (theme_build.js) */
                const v = k === 'visible' ? (s[k] ? 1 : 0) : Math.round(s[k]) + (k === 'y' && l.dy ? l.dy : 0);
                if (v !== last[k]) { set = set || {}; set[k] = v; last[k] = v; }
            });
            if (any || set) out.push({ layer: l, uniforms: changed, set: set });
        });
        return out;
    };

    /* Everything a built theme must keep before a byte goes to the cluster:
     * returns a list of problems (empty when it may run). */
    function check(theme) {
        const p = [];
        if (theme.layers.length > LIMITS.layers) p.push(theme.layers.length + ' layers (at most ' + LIMITS.layers + ')');
        const assets = Object.keys(theme.assets || {});
        if (assets.length > LIMITS.assets) p.push(assets.length + ' assets (at most ' + LIMITS.assets + ')');
        assets.forEach((k) => {
            const a = theme.assets[k];
            if (a.w > LIMITS.side || a.h > LIMITS.side) p.push('asset ' + k + ' is ' + a.w + 'x' + a.h);
            if (a.w * a.h * (a.format === 'r8' ? 1 : 4) > LIMITS.frame) p.push('asset ' + k + ' is bigger than one frame message');
            /* the KOMBI reads rows 4-byte aligned: an R8 asset of another width draws sheared */
            if (a.format === 'r8' && a.w % 4) p.push('asset ' + k + ' is R8 and ' + a.w + ' wide (not a multiple of 4)');
        });
        const names = {};
        theme.layers.forEach((l) => {
            if (names[l.name]) p.push('two layers named ' + l.name);
            names[l.name] = true;
            if (!(l.w > 0 && l.h > 0) || l.x < 0 || l.y < 0 || l.x + l.w > 1920) p.push('layer ' + l.name + ' is outside the panel');
            /* a theme drawn to 646 leaves the car's strip to it; one that
             * declares "bottom": 720 covers the strip itself (the panel is under
             * the KOMBI's telltales, so warning lights still show over it) */
            const bottom = theme.bottom >= LIMITS.bottom && theme.bottom <= 720 ? theme.bottom : LIMITS.bottom;
            if (l.y + l.h > bottom) p.push('layer ' + l.name + ' reaches y ' + (l.y + l.h) + ' (the theme ends at ' + bottom + ')');
            Object.keys(l.binds || {}).forEach((s) => { if (!theme.assets[l.binds[s]]) p.push('layer ' + l.name + ' binds a missing asset ' + l.binds[s]); });
            /* moving parts and sprites keep out of what the car draws over
             * (the art, layer "art", may run under it: a hole is cut for the
             * gear window by theme_build.js) */
            if (theme.ship !== false && l.name !== 'art' && !l.panelFree)
                panelProblems([l.x, l.y, l.w, l.h]).forEach((w) => p.push('layer ' + l.name + ' (' + [l.x, l.y, l.w, l.h].join(', ') + ') ' + w));
            if (l.kind === 'effect') {
                const vectors = Object.keys(l.uniforms || {}).reduce((n, k) => n + Math.ceil(l.uniforms[k].length / 4), 0);
                if (vectors > LIMITS.uniformVectors) p.push('layer ' + l.name + ' has ' + vectors + ' uniform vectors (at most ' + LIMITS.uniformVectors + ')');
            }
        });
        return p;
    }

    const api = { LIMITS, PANEL, panelProblems, encodeText, layoutText, Spring, scale, layerUniforms, Differ, check };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ThemeCore = api;
})(this);
