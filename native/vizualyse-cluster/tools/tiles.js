// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The static art as tiles (THEMES.md "Static art"): the art cut into T x T
 * tiles, each distinct tile kept once (an all-black one never: every black
 * tile shares one black slot), packed into one RGBA8 texture together with
 * the tile map that says, for each tile of the screen, which slot holds it.
 *
 * Layout of the texture (W x H, W <= 256 T, H <= 256 T, both <= 2048):
 *   - the map at its top-left, mapW x mapH texels: map texel (i, j) holds
 *     screen tile (2i, j) in R, G (its slot's column and row, in tiles) and
 *     screen tile (2i + 1, j) in B, A. Two tiles a texel halves the map.
 *   - the tiles in the slots the map leaves free, in raster order, the first
 *     of them black.
 * art.frag and gauge.frag look a pixel up as: tile = floor(p / T) (p in art
 * pixels), the map texel (floor(tile.x / 2), tile.y), the slot from its RG
 * or BA, then the slot's texel at the pixel's place in the tile: nearest
 * sampling at texel centres, so the art comes back exactly.
 *
 *   const t = tile(rgba, w, h, T);   -> { w, h, rgba, T, mapW, mapH, slots, distinct, black }
 *   untile(t, w, h)                  -> the art again (the build checks it)
 */
'use strict';

/* The tiles, deduplicated: a key per tile's pixels. */
function cut(rgba, w, h, T) {
    const tw = Math.ceil(w / T), th = Math.ceil(h / T);
    const index = new Map();          /* key -> distinct tile number */
    const tiles = [];                 /* distinct tiles' pixels, T*T*4 each */
    const at = new Int32Array(tw * th);   /* screen tile -> distinct number, -1 black */
    const buf = Buffer.alloc(T * T * 4);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        buf.fill(0);
        let any = false;
        for (let y = 0; y < T; y++) {
            const sy = ty * T + y;
            if (sy >= h) break;
            for (let x = 0; x < T; x++) {
                const sx = tx * T + x;
                if (sx >= w) break;
                const i = (sy * w + sx) * 4, o = (y * T + x) * 4;
                buf[o] = rgba[i]; buf[o + 1] = rgba[i + 1]; buf[o + 2] = rgba[i + 2]; buf[o + 3] = rgba[i + 3];
                if (rgba[i] | rgba[i + 1] | rgba[i + 2] | (rgba[i + 3] ^ 255)) any = true;
            }
        }
        if (!any) { at[ty * tw + tx] = -1; continue; }
        const key = buf.toString('latin1');
        let n = index.get(key);
        if (n === undefined) { n = tiles.length; index.set(key, n); tiles.push(Buffer.from(buf)); }
        at[ty * tw + tx] = n;
    }
    return { tw, th, tiles, at };
}

/* The free slots of a W x H texture (in tiles) around a mapW x mapH map, in raster order. */
function freeSlots(sw, sh, mapW, mapH, T, need) {
    const out = [];
    const mw = Math.ceil(mapW / T), mh = Math.ceil(mapH / T);
    for (let y = 0; y < sh && out.length < need; y++) for (let x = 0; x < sw && out.length < need; x++) {
        if (x < mw && y < mh) continue;
        out.push([x, y]);
    }
    return out;
}

function tile(rgba, w, h, T) {
    T = T || 4;
    const c = cut(rgba, w, h, T);
    const mapW = Math.ceil(c.tw / 2), mapH = c.th;
    const need = c.tiles.length + 1;          /* + the black slot */
    const limit = Math.min(256, Math.floor(2048 / T));   /* a slot's column and row are a byte each */
    const mw = Math.ceil(mapW / T), mh = Math.ceil(mapH / T);
    /* the smallest texture: every width from the map's up to the limit */
    let best = null;
    for (let sw = mw; sw <= limit; sw++) {
        const perRowBelow = sw;
        const besideMap = (sw - mw) * mh;
        const rest = Math.max(0, need - besideMap);
        const sh = mh + Math.ceil(rest / perRowBelow);
        if (sh > limit) continue;
        const area = sw * sh;
        if (!best || area < best.area || (area === best.area && Math.abs(sw - sh) < Math.abs(best.sw - best.sh))) best = { sw, sh, area };
    }
    if (!best) throw new Error('the art has ' + need + ' distinct tiles of ' + T + ' px: more than one texture holds');
    const W = best.sw * T, H = best.sh * T;
    const out = Buffer.alloc(W * H * 4);
    const slots = freeSlots(best.sw, best.sh, mapW, mapH, T, need);
    const put = (slot, px) => {
        for (let y = 0; y < T; y++) px.copy(out, ((slot[1] * T + y) * W + slot[0] * T) * 4, y * T * 4, (y + 1) * T * 4);
    };
    /* slot 0: black (opaque) */
    const black = Buffer.alloc(T * T * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    put(slots[0], black);
    c.tiles.forEach((px, n) => put(slots[n + 1], px));
    /* the map */
    for (let ty = 0; ty < c.th; ty++) for (let tx = 0; tx < c.tw; tx++) {
        const n = c.at[ty * c.tw + tx];
        const s = slots[n + 1];
        const o = (ty * W + (tx >> 1)) * 4 + (tx & 1) * 2;
        out[o] = s[0]; out[o + 1] = s[1];
    }
    return { w: W, h: H, rgba: out, T, mapW, mapH, slots: best.sw * best.sh, distinct: c.tiles.length,
        black: Array.prototype.filter.call(c.at, (n) => n < 0).length, screen: c.tw * c.th };
}

/* The art back from its tiles, as the shaders read it. */
function untile(t, w, h) {
    const T = t.T, out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const tx = Math.floor(x / T), ty = Math.floor(y / T);
        const m = (ty * t.w + (tx >> 1)) * 4 + (tx & 1) * 2;
        const sx = t.rgba[m] * T + (x - tx * T), sy = t.rgba[m + 1] * T + (y - ty * T);
        t.rgba.copy(out, (y * w + x) * 4, (sy * t.w + sx) * 4, (sy * t.w + sx) * 4 + 4);
    }
    return out;
}

module.exports = { tile, untile };
