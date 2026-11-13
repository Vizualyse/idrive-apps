// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Fields for the gauge shader (THEMES.md "Fields"): for each pixel of a
 * rectangle, its position along a path (16 bits in R, G), its signed
 * distance from the path (B = 128 + d, d > 0 inward) and whether it belongs
 * to the gauge (A). Worked out once at build time so the KOMBI's GPU reads
 * one texel instead of walking the path.
 *
 * A path is a list of pieces, each continuing from the last point:
 *   ["M", x, y]                     start
 *   ["L", x, y]                     a line
 *   ["Q", cx, cy, x, y]             a quadratic curve
 *   ["C", c1x, c1y, c2x, c2y, x, y] a cubic curve
 *   ["A", cx, cy, r, a0, a1]        a circular arc about (cx, cy), degrees
 *                                   clockwise on screen from +x (starts at a0)
 * in screen pixels. inward: 1 puts d > 0 on the side that is up (smaller y)
 * where the path runs to the right (+x); inward: -1 the other side.
 */
'use strict';

function flatten(pieces, step) {
    const pts = [];
    let x = 0, y = 0;
    const add = (px, py) => { pts.push([px, py]); x = px; y = py; };
    const n = (len) => Math.max(2, Math.ceil(len / (step || 4)));
    pieces.forEach((p) => {
        if (p[0] === 'M') add(p[1], p[2]);
        else if (p[0] === 'L') add(p[1], p[2]);
        else if (p[0] === 'Q') {
            const x0 = x, y0 = y, k = n(Math.hypot(p[1] - x0, p[2] - y0) + Math.hypot(p[3] - p[1], p[4] - p[2]));
            for (let i = 1; i <= k; i++) {
                const t = i / k, u = 1 - t;
                add(u * u * x0 + 2 * u * t * p[1] + t * t * p[3], u * u * y0 + 2 * u * t * p[2] + t * t * p[4]);
            }
        } else if (p[0] === 'C') {
            const x0 = x, y0 = y;
            const k = n(Math.hypot(p[1] - x0, p[2] - y0) + Math.hypot(p[3] - p[1], p[4] - p[2]) + Math.hypot(p[5] - p[3], p[6] - p[4]));
            for (let i = 1; i <= k; i++) {
                const t = i / k, u = 1 - t;
                add(u * u * u * x0 + 3 * u * u * t * p[1] + 3 * u * t * t * p[3] + t * t * t * p[5],
                    u * u * u * y0 + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6]);
            }
        } else if (p[0] === 'A') {
            const cx = p[1], cy = p[2], r = p[3], a0 = p[4], a1 = p[5];
            const k = n(Math.abs(a1 - a0) * Math.PI / 180 * r);
            for (let i = pts.length ? 1 : 0; i <= k; i++) {
                const a = (a0 + (a1 - a0) * i / k) * Math.PI / 180;
                add(cx + r * Math.cos(a), cy + r * Math.sin(a));
            }
        } else throw new Error('unknown path piece ' + p[0]);
    });
    return pts;
}

function measure(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return cum;
}

/* rect [x, y, w, h] in screen pixels; maxd how far from the path a pixel
 * still belongs (px, <= 127); ends: false leaves out pixels whose nearest
 * point is an end of the path (beyond its start or its finish). */
function makeField(spec) {
    const pts = flatten(spec.path, spec.step);
    const cum = measure(pts);
    const total = cum[cum.length - 1];
    const inward = spec.inward === -1 ? -1 : 1;
    const maxd = Math.min(127, spec.maxd || 127);
    const [rx, ry, w, h] = spec.rect;
    const out = Buffer.alloc(w * h * 4);
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
        const ax = pts[i][0], ay = pts[i][1], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
        const l2 = dx * dx + dy * dy;
        if (l2 > 1e-9) segs.push({ ax, ay, dx, dy, l2, len: Math.sqrt(l2), c0: cum[i],
            minx: Math.min(ax, ax + dx) - maxd, maxx: Math.max(ax, ax + dx) + maxd,
            miny: Math.min(ay, ay + dy) - maxd, maxy: Math.max(ay, ay + dy) + maxd });
    }
    for (let y = 0; y < h; y++) {
        const py = ry + y + 0.5;
        const near = segs.filter((s) => py >= s.miny && py <= s.maxy);
        for (let x = 0; x < w; x++) {
            const px = rx + x + 0.5;
            let best = Infinity, bt = 0, bd = 0, end = false;
            for (let k = 0; k < near.length; k++) {
                const s = near[k];
                if (px < s.minx || px > s.maxx) continue;
                let u = ((px - s.ax) * s.dx + (py - s.ay) * s.dy) / s.l2;
                const raw = u;
                u = u < 0 ? 0 : u > 1 ? 1 : u;
                const qx = s.ax + u * s.dx - px, qy = s.ay + u * s.dy - py;
                const dist2 = qx * qx + qy * qy;
                if (dist2 < best) {
                    best = dist2;
                    bt = (s.c0 + u * s.len) / total;
                    /* left of travel: cross(dir, p - a) < 0 on screen (y down) */
                    const cross = s.dx * (py - s.ay) - s.dy * (px - s.ax);
                    bd = Math.sqrt(dist2) * (cross < 0 ? 1 : -1) * inward;
                    end = (raw < 0 && s.c0 === 0) || (raw > 1 && Math.abs(s.c0 + s.len - total) < 1e-6);
                }
            }
            const o = (y * w + x) * 4;
            if (best === Infinity || Math.abs(bd) > maxd || (end && !spec.ends)) continue;
            const t16 = Math.round(Math.max(0, Math.min(1, bt)) * 65535);
            out[o] = t16 >> 8;
            out[o + 1] = t16 & 255;
            out[o + 2] = Math.max(0, Math.min(255, 128 + Math.round(bd)));
            out[o + 3] = 255;
        }
    }
    return { w, h, rgba: out, length: total, points: pts };
}

module.exports = { makeField, flatten, measure };
