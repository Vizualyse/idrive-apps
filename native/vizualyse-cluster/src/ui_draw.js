// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A small software canvas for the picker on the central screen (picker.js):
 * an opaque RGBX picture (4 bytes a pixel, the 4th always 255) that the
 * tool hands to mgu-render as a pixmap. Node 8, no dependencies.
 *
 *   fill, rrect (anti-aliased rounded rectangle, optionally translucent),
 *   ring (its outline), image (an RGBA picture, optionally with rounded
 *   corners), text (a glyph atlas built off the car by tools/picker_build.js,
 *   tinted), measure; resize (area-averaged, for the previews).
 *
 * Colours are 0xRRGGBB numbers.
 */
'use strict';

function rgb(c) { return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; }

/* signed distance from a pixel centre to a rounded rectangle (negative inside) */
function rrDist(px, py, x, y, w, h, r) {
    const hx = w / 2, hy = h / 2, cx = x + hx, cy = y + hy;
    const qx = Math.abs(px - cx) - (hx - r), qy = Math.abs(py - cy) - (hy - r);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

class Canvas {
    constructor(w, h) {
        this.w = w; this.h = h;
        this.px = Buffer.alloc(w * h * 4, 255);
    }

    _blend(i, c, a) {
        const p = this.px;
        if (a >= 1) { p[i] = c[0]; p[i + 1] = c[1]; p[i + 2] = c[2]; return; }
        p[i] = p[i] + (c[0] - p[i]) * a + 0.5 | 0;
        p[i + 1] = p[i + 1] + (c[1] - p[i + 1]) * a + 0.5 | 0;
        p[i + 2] = p[i + 2] + (c[2] - p[i + 2]) * a + 0.5 | 0;
    }

    _clip(x, y, w, h) {
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
        return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
    }

    fill(x, y, w, h, colour) {
        const c = rgb(colour), b = this._clip(x, y, w, h);
        if (!b) return;
        const pat = Buffer.from([c[0], c[1], c[2], 255]);
        for (let yy = b[1]; yy < b[3]; yy++) this.px.fill(pat, (yy * this.w + b[0]) * 4, (yy * this.w + b[2]) * 4);
    }

    /* a rounded rectangle, anti-aliased; alpha 0..1 */
    rrect(x, y, w, h, r, colour, alpha) {
        const c = rgb(colour), a = alpha === undefined ? 1 : alpha, b = this._clip(x, y, w, h);
        if (!b) return;
        r = Math.min(r, w / 2, h / 2);
        for (let yy = b[1]; yy < b[3]; yy++) {
            const inner = yy + 0.5 >= y + r && yy + 0.5 <= y + h - r;
            for (let xx = b[0]; xx < b[2]; xx++) {
                let cov;
                if (inner || (xx + 0.5 >= x + r && xx + 0.5 <= x + w - r)) {
                    /* away from the corners: only the edges are partial */
                    cov = Math.min(1, xx + 1 - x, x + w - xx, yy + 1 - y, y + h - yy);
                } else {
                    cov = Math.min(1, Math.max(0, 0.5 - rrDist(xx + 0.5, yy + 0.5, x, y, w, h, r)));
                }
                if (cov > 0) this._blend((yy * this.w + xx) * 4, c, cov * a);
            }
        }
    }

    /* the outline of a rounded rectangle, t px wide, inside its bounds */
    ring(x, y, w, h, r, t, colour, alpha) {
        const c = rgb(colour), a = alpha === undefined ? 1 : alpha, b = this._clip(x, y, w, h);
        if (!b) return;
        r = Math.min(r, w / 2, h / 2);
        const ri = Math.max(0, r - t);
        for (let yy = b[1]; yy < b[3]; yy++) {
            for (let xx = b[0]; xx < b[2]; xx++) {
                const px = xx + 0.5, py = yy + 0.5;
                /* only near the edge */
                if (px > x + t + 1 && px < x + w - t - 1 && py > y + t + 1 && py < y + h - t - 1 &&
                    px > x + r && px < x + w - r && py > y + r && py < y + h - r) continue;
                const out = Math.min(1, Math.max(0, 0.5 - rrDist(px, py, x, y, w, h, r)));
                const inn = Math.min(1, Math.max(0, 0.5 - rrDist(px, py, x + t, y + t, w - 2 * t, h - 2 * t, ri)));
                const cov = out - inn;
                if (cov > 0) this._blend((yy * this.w + xx) * 4, c, cov * a);
            }
        }
    }

    /* an RGBA picture { w, h, rgba } at x, y (its alpha blended), optionally
     * with rounded corners of radius r */
    image(img, x, y, r) {
        x = Math.round(x); y = Math.round(y);
        const b = this._clip(x, y, img.w, img.h);
        if (!b) return;
        const s = img.rgba, c = [0, 0, 0];
        if (img.opaque === undefined) {
            img.opaque = true;
            for (let i = 3; i < s.length; i += 4) if (s[i] !== 255) { img.opaque = false; break; }
        }
        for (let yy = b[1]; yy < b[3]; yy++) {
            const sy = yy - y;
            const cornerRow = r && (sy < r || sy >= img.h - r);
            if (img.opaque && !cornerRow) {
                /* an opaque row: copied as it is (RGBA onto RGBX, the alpha 255) */
                s.copy(this.px, (yy * this.w + b[0]) * 4, (sy * img.w + b[0] - x) * 4, (sy * img.w + b[2] - x) * 4);
                continue;
            }
            for (let xx = b[0]; xx < b[2]; xx++) {
                const sx = xx - x, si = (sy * img.w + sx) * 4;
                let a = s[si + 3] / 255;
                if (cornerRow && (sx < r || sx >= img.w - r)) a *= Math.min(1, Math.max(0, 0.5 - rrDist(sx + 0.5, sy + 0.5, 0, 0, img.w, img.h, r)));
                if (a <= 0) continue;
                c[0] = s[si]; c[1] = s[si + 1]; c[2] = s[si + 2];
                this._blend((yy * this.w + xx) * 4, c, a);
            }
        }
    }

    /* a vertical fade over x, y, w, h: alpha a0 at the top to a1 at the bottom */
    fade(x, y, w, h, colour, a0, a1) {
        const c = rgb(colour), b = this._clip(x, y, w, h);
        if (!b) return;
        for (let yy = b[1]; yy < b[3]; yy++) {
            const a = a0 + (a1 - a0) * ((yy + 0.5 - y) / h);
            for (let xx = b[0]; xx < b[2]; xx++) this._blend((yy * this.w + xx) * 4, c, a);
        }
    }

    /* text in a font (picker_build's atlas): x is its left, centre or right
     * edge (align 'left', 'center', 'right'), y the top of its line box;
     * clipped to maxW when given (an ellipsis is the caller's) */
    text(font, str, x, y, colour, align, maxW) {
        const w = measure(font, str);
        if (align === 'center') x -= w / 2; else if (align === 'right') x -= w;
        x = Math.round(x); y = Math.round(y);
        const c = rgb(colour), right = maxW ? x + maxW : this.w;
        let pen = x;
        for (let k = 0; k < str.length; k++) {
            const g = font.index[str[k]];
            if (g === undefined) { pen += font.adv[font.index[' ']] || 0; continue; }
            const gx = g * font.cell, ty = y + font.top;
            for (let row = 0; row < font.h; row++) {
                const yy = ty + row;
                if (yy < 0 || yy >= this.h) continue;
                for (let col = 0; col < font.cell; col++) {
                    const xx = pen + col;
                    if (xx < 0 || xx >= this.w || xx >= right) continue;
                    const v = font.r8[row * font.w + gx + col];
                    if (v) this._blend((yy * this.w + xx) * 4, c, v / 255);
                }
            }
            pen += font.adv[g];
        }
        return w;
    }
}

function measure(font, str) {
    let w = 0;
    for (let k = 0; k < str.length; k++) {
        const g = font.index[str[k]];
        w += font.adv[g === undefined ? font.index[' '] : g] || 0;
    }
    return w;
}

/* str cut to fit maxW, with "..." */
function fit(font, str, maxW) {
    if (measure(font, str) <= maxW) return str;
    let s = str;
    while (s.length && measure(font, s + '...') > maxW) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '...';
}

/* an RGBA picture resized by area averaging (each output pixel the mean of
 * the source pixels it covers): sharp enough for downscaling previews */
function resize(img, w, h) {
    const out = Buffer.alloc(w * h * 4), sx = img.w / w, sy = img.h / h;
    const acc = new Float64Array(4);
    for (let y = 0; y < h; y++) {
        const y0 = y * sy, y1 = y0 + sy;
        for (let x = 0; x < w; x++) {
            const x0 = x * sx, x1 = x0 + sx;
            acc.fill(0);
            let total = 0;
            for (let yy = Math.floor(y0); yy < Math.min(img.h, Math.ceil(y1)); yy++) {
                const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
                for (let xx = Math.floor(x0); xx < Math.min(img.w, Math.ceil(x1)); xx++) {
                    const wgt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx)), i = (yy * img.w + xx) * 4;
                    acc[0] += img.rgba[i] * wgt; acc[1] += img.rgba[i + 1] * wgt; acc[2] += img.rgba[i + 2] * wgt; acc[3] += img.rgba[i + 3] * wgt;
                    total += wgt;
                }
            }
            const o = (y * w + x) * 4;
            for (let k = 0; k < 4; k++) out[o + k] = Math.round(acc[k] / total);
        }
    }
    return { w, h, rgba: out };
}

/* the middle w x h of a picture (a cover crop) */
function crop(img, x, y, w, h) {
    const out = Buffer.alloc(w * h * 4);
    for (let r = 0; r < h; r++) img.rgba.copy(out, r * w * 4, ((r + y) * img.w + x) * 4, ((r + y) * img.w + x + w) * 4);
    return { w, h, rgba: out };
}

module.exports = { Canvas, measure, fit, resize, crop, rgb };
