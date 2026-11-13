// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The perf1 family's gen helpers (Sport perf1/gen.js, Comfort perf1c/gen.js):
 * Archivo fonts from fonts/metrics.json (fonts.py), text layers placed by
 * baseline as the mockup's SVG places them, the round open-bottomed dial's
 * field and gauge, leds-drawn bars, and the JSON writer. Everything is in
 * the mockup's own 1920 x 720 units.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const METRICS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fonts', 'metrics.json'), 'utf8'));
const FONT_FILES = { '600-108': 'Archivo-600-108.woff2', '500-100': 'Archivo-500-100.woff2' };

const hex = (h, a) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a == null ? 1 : a]
    .map((v) => Math.round(v * 1000) / 1000);
const scaleRGB = (c, k) => [c[0] * k, c[1] * k, c[2] * k, c[3]].map((v) => Math.round(v * 1000) / 1000);

/* The mockup's palette (DESIGN.md) */
const C = {
    ground: hex('#000000'), disc: hex('#0b0d12'), line: hex('#272b34'), track: hex('#171a20'),
    ink: hex('#f3f5f8'), ink2: hex('#a6aebb'), ink3: hex('#7f8896'), tick: hex('#5c6473'),
    sport: hex('#ff3a22'), deep: hex('#b9141a'), amber: hex('#ffb224'), elec: hex('#3d9bff'), none: [0, 0, 0, 0],
};

/* A font: an Archivo instance at a size with the glyphs it needs. The cell
 * holds the ascender and the descender; the build centres a glyph's line box
 * in its cell, moved down dy, so the baseline sits at `base` px in the cell. */
function font(inst, size, glyphs) {
    const m = METRICS[inst];
    const adv = glyphs.split('').map((c) => {
        if (m.adv[c] == null) throw new Error('Archivo ' + inst + ' has no "' + c + '"');
        return Math.round(m.adv[c] * size / m.upm);
    });
    const above = Math.ceil(0.80 * size) + 2, below = Math.ceil(0.24 * size) + 1;
    const ch = above + below, cw = Math.max.apply(null, adv) + Math.ceil(size * 0.06) + 2;
    const mid = ch / 2 + (m.asc - m.desc) / 2 / m.upm * size;
    /* the logic places glyphs at fractional advances, as Chrome does */
    const advf = glyphs.split('').map((c) => Math.round(m.adv[c] * size / m.upm * 100) / 100);
    return { inst, size, glyphs, adv, advf, cw, ch, base: above, dy: Math.round((above - mid) * 10) / 10 };
}
/* dir: the fonts' folder from the theme's own (perf1c: '../perf1/fonts/') */
function fontSpec(f, dir) {
    return { file: (dir || 'fonts/') + FONT_FILES[f.inst], weight: +f.inst.split('-')[0], size: f.size, cell: [f.cw, f.ch], dy: f.dy, glyphs: f.glyphs };
}

/* A text layer of one reading, its baseline at by and anchored at bx as the
 * mockup's text-anchor is (start, middle, end). */
function text(name, f, fname, cells, anchor, bx, by, color, extra) {
    const w = f.cw * cells;
    const x = anchor === 'end' ? bx - w : anchor === 'middle' ? bx - w / 2 : bx;
    const l = { name, shader: 'text', font: fname, x: Math.round(x), y: Math.round(by - f.base), cells,
        align: anchor === 'end' ? 'right' : anchor === 'middle' ? 'center' : 'left', uniforms: { u_color: color || C.ink } };
    return Object.assign(l, extra || {});
}
/* A text layer the logic lays out itself (several readings in one font,
 * colour and baseline): x0..x1 in the panel. */
function textRow(name, f, fname, x0, x1, by, color) {
    return { name, shader: 'text', font: fname, x: Math.round(x0), y: Math.round(by - f.base), w: Math.ceil(x1 - x0), cells: 16,
        align: 'left', uniforms: { u_color: color || C.ink } };
}

/* A round dial open at the bottom, as the mockup's Dial(): clock angles
 * -120..120 from the top. The path runs at radius r a little past both ends
 * (so the needle at an end shows whole), clockwise; d > 0 towards the centre. */
function dialPath(cx, cy, r, extraDeg, reach, inner) {
    const a0 = -120 - extraDeg - 90, a1 = 120 + extraDeg - 90;
    /* the rectangle: the ring reach px out from the path, to the inner radius in */
    const R = r + reach, y1 = cy + Math.max(R, inner) * Math.sin(a1 * Math.PI / 180);
    const rect = [Math.floor(cx - R), Math.floor(cy - R), Math.ceil(2 * R), Math.ceil(y1 + 2 - (cy - R))];
    const len = r * (a1 - a0) * Math.PI / 180;
    return { spec: { path: [['A', cx, cy, r, a0, a1]], inward: -1, rect, maxd: Math.max(reach, r - inner) },
        len, t0: extraDeg / (240 + 2 * extraDeg), t1: (240 + extraDeg) / (240 + 2 * extraDeg) };
}

/* leds layers */
function leds(name, x, y, w, h, u) {
    return { name, shader: 'leds', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), uniforms: u };
}
/* a bar that fills left to right: one 1 px light a pixel; unlit is clear (the art has the track) */
function barLeds(name, x, y, w, h, color) {
    return leds(name, x, y, w, h, { u_led: [Math.round(w), 0, 0, 0], u_geom: [0, 0, 1, h], u_split: [99, 99, 0, 0],
        u_c0: color, u_c1: color, u_c2: color, u_off: C.none });
}
function rect(name, x, y, w, h, radius, color, extra) {
    return Object.assign({ name, shader: 'rect', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
        uniforms: { u_shape: [0, 0, radius, 0], u_color: color } }, extra || {});
}

/* The fonts' advances and the layout rows, for the logic's own layout */
function fontParams(fonts) {
    const out = {};
    Object.keys(fonts).forEach((k) => { out[k] = { g: fonts[k].glyphs, adv: fonts[k].advf, cw: fonts[k].cw }; });
    return out;
}

function write(dir, spec) {
    const json = JSON.stringify(spec, null, 1)
        .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']');
    fs.writeFileSync(path.join(dir, 'theme.src.json'), json + '\n');
}

module.exports = { C, hex, scaleRGB, font, fontSpec, text, textRow, dialPath, leds, barLeds, rect, fontParams, write };
