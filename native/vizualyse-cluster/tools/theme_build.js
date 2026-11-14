// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Builds a theme from its source (THEMES.md "Building a theme") into the
 * kit's flat files in themes/built/:
 *   <id>.theme.json        the layers, assets and numbers the tool and the preview read
 *   <id>.art.tiles.gz      the static art (1920 x bottom, from art.html, headless Chrome)
 *                          as its distinct tiles and their map, RGBA (tools/tiles.js)
 *   <id>.<name>.field.gz   each path's field (tools/field.js), cropped to its pixels
 *   <id>.<name>.font.gz    each font's glyph atlas, R8 (headless Chrome), cropped to its ink's rows
 *   <id>.logic.js          the theme's logic, as written
 * and, with --list, lists every built theme in component.json's files.
 * Refuses a theme that breaks theme_core.check (the strip at y 646, the
 * layer and asset limits).
 *
 *   node tools/theme_build.js themes/<id> [--chrome PATH] [--keep] [--list]
 *
 * theme.src.json:
 * {
 *   "id": "g20i1", "title": "G20 inspired 1", "bottom": 646,
 *   "params": { ... anything the logic reads: shift points, scales },
 *   "fonts": { "big": { "file": "fonts/x.woff2", "family": "X", "weight": 500,
 *                       "size": 104, "cell": [58, 110], "dy": 0,
 *                       "glyphs": "0123456789 -" } },     each glyph centred in its cell, moved down dy px
 *   "paths": { "speed": { "path": [["M",x,y],["L",x,y],...], "inward": 1,
 *                         "rect": [x,y,w,h], "maxd": 110 } },
 *   "layers": [
 *     { "name": "speed", "shader": "gauge", "field": "speed", "z": 1,
 *       "uniforms": { "u_band": [...], ... } },        rect and u_val.y come from the path
 *     { "name": "speedText", "shader": "text", "font": "big", "x": 300, "y": 220,
 *       "cells": 3, "align": "right", "uniforms": { "u_color": [1,1,1,1] } },
 *     { "name": "shift", "shader": "leds", "x": .., "y": .., "w": .., "h": .., "uniforms": {...} },
 *     { "name": "chip", "shader": "rect", "x": .., "y": .., "w": .., "h": .., "uniforms": {...} }
 *   ]
 * }
 * The art layer comes first by itself (the whole drawn area, an image layer).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const { spawnSync } = require('child_process');
const { readPng, writePng } = require('./png.js');
const { makeField } = require('./field.js');
const tiles = require('./tiles.js');
const core = require('../src/theme_core.js');

const HERE = path.resolve(__dirname, '..');
const OUT = path.join(HERE, 'themes', 'built');
const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const SHADERS = ['art', 'gauge', 'text', 'leds', 'rect'];

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function chrome() {
    const c = [arg('--chrome')].concat(CHROMES).filter((p) => p && fs.existsSync(p))[0];
    if (!c) throw new Error('no Chrome or Edge found (CHROME=... or --chrome)');
    return c;
}

/* A page's screenshot at w x h, as RGBA. */
function shoot(htmlFile, w, h, tmp) {
    const png = path.join(tmp, 'shot-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png');
    const url = 'file:///' + htmlFile.replace(/\\/g, '/');
    const r = spawnSync(chrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--force-color-profile=srgb', '--default-background-color=000000ff', '--virtual-time-budget=4000',
        '--user-data-dir=' + path.join(tmp, 'profile'), '--window-size=' + w + ',' + h, '--screenshot=' + png, url],
        { encoding: 'utf8', timeout: 120000 });
    if (!fs.existsSync(png)) throw new Error('screenshot failed: ' + (r.stderr || r.error || '').toString().slice(-400));
    const img = readPng(fs.readFileSync(png));
    if (img.w !== w || img.h < h) throw new Error('screenshot is ' + img.w + 'x' + img.h + ', wanted ' + w + 'x' + h);
    if (img.h > h) img.rgba = img.rgba.slice(0, w * h * 4);
    img.h = h;
    return img;
}

/* A glyph atlas: one row of cells, white glyphs on black, each glyph from
 * its cell's left edge, the font embedded; and each glyph's advance (its
 * width in text), which the page measures and draws as a bar under its cell
 * (a screenshot is all that comes back from Chrome). */
function fontAtlas(src, f, tmp) {
    const fontFile = path.join(src, f.file);
    const data = fs.readFileSync(fontFile).toString('base64');
    const fmt = /\.woff2$/.test(fontFile) ? 'woff2' : /\.woff$/.test(fontFile) ? 'woff' : 'truetype';
    const glyphs = f.glyphs;
    const cw = f.cell[0], w = cw * glyphs.length, h = f.cell[1];
    const esc = (c) => c === ' ' ? '&nbsp;' : c.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const cells = glyphs.split('').map((c, i) =>
        '<div class="g" style="left:' + (i * cw) + 'px;top:' + (f.dy || 0) + 'px;height:' + h + 'px;line-height:' + h + 'px"><span>' + esc(c) + '</span></div>' +
        '<div class="bar" id="b' + i + '" style="left:' + (i * cw) + 'px"></div>').join('');
    const page = '<!doctype html><meta charset="utf-8"><style>@font-face{font-family:A;src:url(data:font/' + fmt + ';base64,' + data + ') format("' + fmt + '");font-weight:' + (f.weight || 400) + '}' +
        'html,body{margin:0;background:#000;width:' + w + 'px;height:' + (h + 8) + 'px;overflow:hidden}' +
        '.g{position:absolute;white-space:pre;font-family:A;font-weight:' + (f.weight || 400) + ';font-size:' + f.size + 'px;color:#fff;' +
        'font-variant-numeric:' + (f.proportional ? 'proportional-nums' : 'tabular-nums') + ';letter-spacing:' + (f.tracking || 0) + 'px}' +
        '.bar{position:absolute;top:' + (h + 2) + 'px;height:4px;width:0;background:#fff}</style><body>' + cells +
        '<script>document.fonts.ready.then(function(){var s=document.querySelectorAll(".g span");' +
        'for(var i=0;i<s.length;i++)document.getElementById("b"+i).style.width=Math.round(s[i].getBoundingClientRect().width)+"px";});</script></body>';
    const file = path.join(tmp, 'font.html');
    fs.writeFileSync(file, page);
    /* Chrome's window is at least ~500 px wide: shoot wider, keep the atlas */
    const shotW = Math.max(w, 600), shotH = Math.max(h + 8, 100);
    const img = shoot(file, shotW, shotH, tmp);
    /* only the rows with ink: the text layer is moved down by the rows cut
     * from the top (its "dy") and made as tall as what is left */
    let top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (img.rgba[(y * shotW + x) * 4]) { top = Math.min(top, y); bottom = y; break; }
    if (bottom < 0) { top = 0; bottom = 0; }
    const th = bottom - top + 1;
    const out = Buffer.alloc(w * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < w; x++) out[y * w + x] = img.rgba[((y + top) * shotW + x) * 4];
    const adv = glyphs.split('').map((c, i) => {
        let n = 0;
        while (n < cw && img.rgba[((h + 4) * shotW + i * cw + n) * 4] > 127) n++;
        if (n >= cw && c !== ' ') console.warn('font ' + f.file + ' ' + f.size + 'px: "' + c + '" is as wide as its cell (' + cw + ' px): widen the cell');
        return n;
    });
    if (adv.every((n) => n === 0)) throw new Error('font ' + f.file + ': no advances measured (did the font load?)');
    return { w, h: th, top, r8: out, adv };
}

/* A field cut to the bounds of its pixels (A > 0): the rest draws nothing
 * (gauge.frag returns transparent there) and needs no upload or fill. */
function cropField(f) {
    let x0 = f.w, y0 = f.h, x1 = -1, y1 = -1;
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
        if (!f.rgba[(y * f.w + x) * 4 + 3]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return Object.assign({}, f, { x0: 0, y0: 0, x2: 0 });
    const w = x1 - x0 + 1, h = y1 - y0 + 1, rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) f.rgba.copy(rgba, y * w * 4, ((y + y0) * f.w + x0) * 4, ((y + y0) * f.w + x1 + 1) * 4);
    return Object.assign({}, f, { w, h, rgba, x0, y0, x2: f.w - 1 - x1 });
}

function gz(buf) { return zlib.gzipSync(buf, { level: 9, mtime: 0 }); }

function build(src) {
    const spec = JSON.parse(fs.readFileSync(path.join(src, 'theme.src.json'), 'utf8'));
    const id = spec.id;
    if (!/^[a-z0-9]+$/.test(id)) throw new Error('theme id must be [a-z0-9]+');
    const bottom = spec.bottom || core.LIMITS.bottom;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-' + id + '-'));
    const written = [];
    /* A texture byte for byte the same as one another theme of the family
     * already built (Sport and Comfort sharing a field or a font) is not
     * written twice: the theme names that file, so the kit carries it once
     * and the tool keeps it on the cluster across a mode switch. */
    const family = spec.family || id;
    const twin = (buf) => fs.readdirSync(OUT).filter((n) => /\.gz$/.test(n) && n.indexOf(id + '.') !== 0).filter((n) => {
        const other = n.split('.')[0], meta = path.join(OUT, other + '.theme.json');
        if (!fs.existsSync(meta)) return false;
        try { if ((JSON.parse(fs.readFileSync(meta, 'utf8')).family || other) !== family) return false; } catch (e) { return false; }
        const st = fs.statSync(path.join(OUT, n));
        return st.size === buf.length && fs.readFileSync(path.join(OUT, n)).equals(buf);
    })[0];
    const put = (name, buf) => {
        const same = /\.gz$/.test(name) ? twin(buf) : null;
        if (same) { try { fs.unlinkSync(path.join(OUT, name)); } catch (e) { /* none */ } return same; }
        fs.writeFileSync(path.join(OUT, name), buf); written.push(name); return name;
    };
    const theme = { id, title: spec.title, family: spec.family || id, mode: spec.mode || 'sport', version: spec.version || 2, ship: spec.ship !== false, bottom, params: spec.params || {}, signals: spec.signals || [], fonts: {}, assets: {}, layers: [] };
    /* the map slot a design marks (tools/design_build.js), for a later map layer */
    if (spec.map) theme.map = spec.map;

    /* the art: an asset (the gauges add their glow to it), drawn by art.frag
     * through its tile map: its distinct tiles, no black one, and the map in
     * one texture (tools/tiles.js), the tile size whichever of 4 and 8 px
     * makes it smaller (4 for nearly every theme); checked against the art */
    const art = shoot(path.resolve(src, spec.art || 'art.html'), 1920, bottom, tmp);
    const tiled = [4, 8].map((T) => tiles.tile(art.rgba, 1920, bottom, T)).sort((a, b) => a.rgba.length - b.rgba.length)[0];
    if (!tiles.untile(tiled, 1920, bottom).equals(art.rgba)) throw new Error('the art\'s tiles do not give the art back');
    const T = tiled.T;
    theme.assets.art = { format: 'rgba8', w: tiled.w, h: tiled.h, sampling: 'nearest', file: put(id + '.art.tiles.gz', gz(tiled.rgba)), sha1: sha1(tiled.rgba),
        tile: T, map: [tiled.mapW, tiled.mapH], tiles: tiled.distinct };
    const artTile = [tiled.w, tiled.h, T, 0];
    theme.layers.push({ name: 'art', kind: 'effect', shader: 'art', x: 0, y: 0, w: 1920, h: bottom, z: -100,
        binds: { u_img: 'art' }, uniforms: { u_area: [0, 0, 1920 / T, bottom / T], u_tile: artTile } });
    let upload = tiled.rgba.length;
    if (process.argv.indexOf('--keep') > 0) fs.writeFileSync(path.join(src, 'art.preview.png'), writePng(1920, bottom, art.rgba));

    /* fields; a path { "mirror": "<other path>" } reuses that path's field
     * mirrored left to right (a tach that is the speedometer's mirror image),
     * and { "copy": "<other path>", "at": [x, y] } reuses it moved, the same
     * way round (two identical dials both running clockwise): no second
     * upload either way */
    const fields = {};
    const paths = spec.paths || {};
    Object.keys(paths).filter((n) => paths[n].copy).forEach((name) => {
        if (!paths[paths[name].copy] || paths[paths[name].copy].copy || paths[paths[name].copy].mirror) throw new Error('path ' + name + ' copies ' + paths[name].copy + ', which is not a path of its own');
    });
    Object.keys(paths).filter((n) => !paths[n].mirror && !paths[n].copy).forEach((name) => {
        const p = paths[name];
        const f = cropField(makeField(p));
        const asset = name + 'Field';
        theme.assets[asset] = { format: 'rgba8', w: f.w, h: f.h, sampling: 'nearest', file: put(id + '.' + name + '.field.gz', gz(f.rgba)), sha1: sha1(f.rgba) };
        /* crop: where the cropped field sits in the path's rectangle (x0, y0) and
         * how much was cut on the right (x2), for a mirrored copy */
        fields[name] = { rect: [p.rect[0] + f.x0, p.rect[1] + f.y0, f.w, f.h], length: f.length, asset, flip: 0, crop: [f.x0, f.y0, f.x2] };
        upload += f.rgba.length;
    });
    Object.keys(paths).filter((n) => paths[n].mirror).forEach((name) => {
        const o = fields[paths[name].mirror];
        if (!o) throw new Error('path ' + name + ' mirrors a missing path ' + paths[name].mirror);
        const r = o.rect;
        fields[name] = { rect: [1920 - r[0] - r[2], r[1], r[2], r[3]], length: o.length, asset: o.asset, flip: 1 };
    });
    Object.keys(paths).filter((n) => paths[n].copy).forEach((name) => {
        const o = fields[paths[name].copy], at = paths[name].at;
        if (!Array.isArray(at) || at.length !== 2) throw new Error('path ' + name + ': "at": [x, y] (the copy\'s top-left)');
        /* "flip": true mirrors the copy too (a mirror image anywhere, not only about the screen's middle) */
        const flip = paths[name].flip ? 1 : 0;
        fields[name] = { rect: [at[0] + (flip ? o.crop[2] : o.crop[0]), at[1] + o.crop[1], o.rect[2], o.rect[3]], length: o.length, asset: o.asset, flip };
    });

    /* fonts */
    const fonts = {};
    Object.keys(spec.fonts || {}).forEach((name) => {
        const f = spec.fonts[name];
        const a = fontAtlas(src, f, tmp);
        const asset = name + 'Font';
        theme.assets[asset] = { format: 'r8', w: a.w, h: a.h, sampling: 'bilinear', file: put(id + '.' + name + '.font.gz', gz(a.r8)), sha1: sha1(a.r8) };
        fonts[name] = { glyphs: f.glyphs, cell: f.cell, adv: a.adv, asset, top: a.top, h: a.h };
        theme.fonts[name] = { glyphs: f.glyphs, cell: f.cell, adv: a.adv };
        upload += a.r8.length;
    });

    /* layers */
    spec.layers.forEach((l, i) => {
        const L = { name: l.name, kind: 'effect', shader: l.shader, z: l.z != null ? l.z : i, uniforms: {}, binds: {} };
        Object.keys(l.uniforms || {}).forEach((k) => { L.uniforms[k] = [].concat(l.uniforms[k]); });
        if (SHADERS.indexOf(l.shader) < 0) throw new Error('layer ' + l.name + ': unknown shader ' + l.shader);
        if (l.shader === 'gauge') {
            const f = fields[l.field];
            if (!f) throw new Error('layer ' + l.name + ': no path ' + l.field);
            [L.x, L.y, L.w, L.h] = f.rect;
            const v = L.uniforms.u_val || [0, 0, 2, 0.2];
            v[1] = f.length;
            L.uniforms.u_val = v;
            L.uniforms.u_seg = L.uniforms.u_seg || [0, 0, 0, 1];
            const pool = L.uniforms.u_pool || [0, 0, 0, 0];
            pool[3] = f.flip;
            L.uniforms.u_pool = pool;
            /* the glow added to the art under it, unless "art": false */
            L.uniforms.u_area = l.art === false ? [0, 0, 0, 0] : [L.x / T, L.y / T, L.w / T, L.h / T];
            L.uniforms.u_tile = artTile;
            L.binds.u_field = f.asset;
            L.binds.u_art = 'art';
            L.uniforms.u_look = L.uniforms.u_look || [0.25, 0, 2, 0];
        } else if (l.shader === 'text') {
            const f = fonts[l.font];
            if (!f) throw new Error('layer ' + l.name + ': no font ' + l.font);
            const cells = l.cells || 3;
            if (cells > 16) throw new Error('layer ' + l.name + ': at most 16 glyphs');
            /* the atlas keeps only its ink's rows: the layer starts f.top
             * lower and is that tall; the logic's y is moved by it too (dy) */
            L.x = l.x; L.y = l.y + f.top; L.w = l.w || f.cell[0] * cells; L.h = f.h;
            if (f.top) L.dy = f.top;
            L.glyphs = f.glyphs; L.cells = cells; L.align = l.align || 'right'; L.adv = f.adv; L.cellW = f.cell[0];
            const t = core.layoutText(l.text || '', L);
            L.uniforms.u_text = t.codes;
            L.uniforms.u_pos = t.pos;
            L.uniforms.u_meta = [L.w, f.glyphs.length, f.cell[0], t.count];
            L.uniforms.u_color = L.uniforms.u_color || [1, 1, 1, 1];
            L.binds.u_font = f.asset;
        } else if (l.shader === 'art') {
            /* a sprite (tools/design_build.js): its own small RGBA texture from
             * a PNG beside the source, drawn as art and shown or hidden */
            const img = readPng(fs.readFileSync(path.resolve(src, l.image)));
            if (img.w !== l.w || img.h !== l.h) throw new Error('layer ' + l.name + ': ' + l.image + ' is ' + img.w + 'x' + img.h + ', wanted ' + l.w + 'x' + l.h);
            const asset = l.name + 'Img';
            theme.assets[asset] = { format: 'rgba8', w: img.w, h: img.h, sampling: 'nearest', file: put(id + '.' + l.name + '.sprite.gz', gz(img.rgba)), sha1: sha1(img.rgba) };
            upload += img.rgba.length;
            L.x = l.x; L.y = l.y; L.w = l.w; L.h = l.h;
            L.binds.u_img = asset;
            L.uniforms.u_area = [0, 0, 1, 1];
        } else {
            L.x = l.x; L.y = l.y; L.w = l.w; L.h = l.h;
            if (l.shader === 'leds') {
                const g = L.uniforms.u_geom || [0, 0, 0, 0];
                g[0] = l.w; g[1] = l.h;
                L.uniforms.u_geom = g;
                L.uniforms.u_lean = L.uniforms.u_lean || [0, 0, 0, 0];
            } else {
                const s = L.uniforms.u_shape || [0, 0, 0, 0];
                s[0] = l.w; s[1] = l.h;
                L.uniforms.u_shape = s;
                L.uniforms.u_ring = L.uniforms.u_ring || [0, 0, 0, 0];
            }
        }
        theme.layers.push(L);
    });

    /* an art layer over a texture of its own, not the tiled art (a sprite),
     * draws it as it is: u_tile.z 0 (art.frag) */
    theme.layers.forEach((L) => { if (L.shader === 'art' && !L.uniforms.u_tile) L.uniforms.u_tile = [0, 0, 0, 0]; });

    const problems = core.check(theme);
    if (problems.length) throw new Error('theme ' + id + ':\n  ' + problems.join('\n  '));
    put(id + '.logic.js', fs.readFileSync(path.join(src, 'logic.js')));
    theme.upload = upload;
    /* the KOMBI's fill per frame: every layer's pixels (the art covers the whole drawn area once) */
    theme.fill = theme.layers.reduce((n, l) => n + l.w * l.h, 0);
    put(id + '.theme.json', JSON.stringify(theme, null, 1) + '\n');
    console.log(id + ': ' + theme.layers.length + ' layers, ' + Object.keys(theme.assets).length + ' assets, ' +
        (upload / 1024 / 1024).toFixed(2) + ' MB uploaded at start (' + (upload / 1024 / 5500).toFixed(1) + ' s of the link), ' +
        (theme.fill / 1e6).toFixed(2) + ' Mpx drawn a frame (' + (theme.fill / (1920 * 646)).toFixed(2) + 'x the drawn area)');
    return written;
}

/* component.json's files: the shaders and every built theme file of a theme
 * that ships ("ship": false in theme.src.json keeps one to the preview and
 * the tests, as the sample is), kept in step */
function listFiles(prune) {
    const cj = path.join(HERE, 'component.json');
    if (!fs.existsSync(cj)) return;
    const c = JSON.parse(fs.readFileSync(cj, 'utf8'));
    const keep = c.files.filter((f) => !/^themes\/built\//.test(f.from) && !/^src\/shaders\//.test(f.from));
    /* the files each built theme names: a shipped theme's go in the kit (a
     * file shared within a family is named once) */
    const used = {}, shipped = {};
    fs.readdirSync(OUT).filter((n) => /\.theme\.json$/.test(n)).forEach((n) => {
        const t = JSON.parse(fs.readFileSync(path.join(OUT, n), 'utf8'));
        const names = [n, t.id + '.logic.js'].concat(Object.keys(t.assets).map((k) => t.assets[k].file),
            t.layers.filter((l) => l.file).map((l) => l.file));
        names.forEach((f) => {
            used[f] = true;
            if (t.ship !== false) shipped[f] = true;
            if (!fs.existsSync(path.join(OUT, f))) throw new Error('theme ' + t.id + ' names ' + f + ', which is missing: rebuild it');
        });
    });
    /* --prune: a file no built theme names any more (a renamed path or font) goes */
    if (prune) fs.readdirSync(OUT).filter((n) => !/^\./.test(n) && !used[n]).forEach((n) => { fs.unlinkSync(path.join(OUT, n)); console.log('removed ' + n + ' (no theme uses it)'); });
    const add = SHADERS.map((s) => ({ path: 'fs_' + s + '.frag', from: 'src/shaders/' + s + '.frag', mode: '0644' }))
        .concat(Object.keys(shipped).sort().map((n) => ({ path: n, from: 'themes/built/' + n, mode: '0644' })));
    c.files = keep.concat(add);
    fs.writeFileSync(cj, JSON.stringify(c, null, 2) + '\n');
}

if (require.main === module) {
    const dirs = process.argv.slice(2).filter((a, i, all) => a[0] !== '-' && all[i - 1] !== '--chrome');
    const list = process.argv.indexOf('--list') > 0;
    if (!dirs.length && !list) { console.error('usage: node tools/theme_build.js themes/<id> [...] [--list]'); process.exit(2); }
    fs.mkdirSync(OUT, { recursive: true });
    try {
        dirs.forEach((d) => build(path.resolve(d)));
        /* component.json only with --list: themes built side by side must not race on it */
        if (list) listFiles(process.argv.indexOf('--prune') > 0);
    } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { build, listFiles };
