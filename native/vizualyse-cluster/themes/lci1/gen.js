// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Writes theme.src.json for lci1 ("LCI inspired 1", Sport) from the LCI
 * mockup's own geometry: the hexagon's slanted sides (speed left, revs right,
 * the tach the speedometer's mirror image), the gear box and its upshift
 * chevrons, the power and boost bars, the slanted fluid bars, the shift
 * lights and tyres. Where a reading sits comes from art.html itself: gen.js
 * opens it in headless Chrome with #measure (the mockup's tspans, kept
 * invisible, hold each unit in place) and measures each font's advances the
 * way the build does, so the logic can lay out several readings in one text
 * layer (params.fonts).
 *   node themes/lci1/gen.js
 * build(opts) is the family's: the hexagon's scales, numerals and slanted
 * bars, the helpers and the output; a variant (SPORT here, COMFORT in
 * themes/lci1c/gen.js) gives its fonts and its own layers, paths and params.
 * Fonts: Archivo (OFL), the mockup's subset, in fonts/; wdth 108 as a static
 * instance (fontTools instancer) since the build's atlas page sets no
 * font-stretch.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeField, flatten, measure } = require('../../tools/field.js');

const W = 1920;
const K = 178 / 290;                          /* the one slope: across per down */
const C = 290 / Math.hypot(290, 178);         /* perpendicular per horizontal offset */
const R2 = (v) => Math.round(v * 100) / 100;
const R4 = (v) => Math.round(v * 10000) / 10000;
const hex = (h, a) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a == null ? 1 : a].map((v) => R4(v));

const COL = {
    ground: hex('#020308'), field: hex('#0d33bd'), panel: hex('#040a28'), box: hex('#00030a'), line: hex('#5b86ff'),
    ice: hex('#74e4ff'), iceOff: hex('#0c4560'), red: hex('#ff2a45'), redOff: hex('#4a0b1a'), redTint: hex('#c2183a'),
    redDark: hex('#3a0a16'), pale: hex('#ffd9de'), amber: hex('#ffb224'), text: hex('#f5f8ff'), text2: hex('#b4c8ff'),
    dim: hex('#7f8fb8'), track: hex('#0a1d6a'), trackPanel: hex('#12235e'), tyre: hex('#dfe8ff'), none: [0, 0, 0, 0],
};

/* ---- Chrome ---- */
const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
function dump(url, tmp) {
    const chrome = CHROMES.filter((p) => p && fs.existsSync(p))[0];
    const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--virtual-time-budget=6000', '--window-size=1920,720',
        '--user-data-dir=' + path.join(tmp, 'profile'), '--dump-dom', url], { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 });
    const m = /MEASURE(\{[\s\S]*?\})END/.exec(r.stdout || '');
    if (!m) throw new Error('no measurement from ' + url + ': ' + (r.stderr || '').slice(-400));
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

/* Each font as the build draws its atlas (theme_build.js fontAtlas): the
 * advance of each glyph, and the ink above and below the baseline. */
function measureFonts(src, fonts, tmp) {
    const faces = {}, blocks = [];
    Object.keys(fonts).forEach((name) => {
        const f = fonts[name];
        const key = f.file + '|' + f.weight;
        if (!faces[key]) {
            const data = fs.readFileSync(path.join(src, f.file)).toString('base64');
            faces[key] = 'F' + Object.keys(faces).length;
            blocks.push('@font-face{font-family:' + faces[key] + ';src:url(data:font/woff2;base64,' + data + ') format("woff2");font-weight:' + f.weight + '}');
        }
        f.face = faces[key];
    });
    const spec = Object.keys(fonts).map((name) => {
        const f = fonts[name];
        return { name, face: f.face, weight: f.weight, size: f.size, tracking: f.tracking || 0, glyphs: f.glyphs };
    });
    const page = '<!doctype html><meta charset="utf-8"><style>' + blocks.join('') + '.g{position:absolute;white-space:pre;font-variant-numeric:tabular-nums}</style><body><script>' +
        'var S=' + JSON.stringify(spec) + ';' +
        'document.fonts.load("600 20px F0").then(function(){return Promise.all(S.map(function(s){return document.fonts.load(s.weight+" "+s.size+"px "+s.face);}));}).then(function(){var out={};var cv=document.createElement("canvas").getContext("2d");' +
        'S.forEach(function(s){var adv=[],asc=0,desc=0;s.glyphs.split("").forEach(function(c){var d=document.createElement("div");d.className="g";' +
        'd.style.cssText="font-family:"+s.face+";font-weight:"+s.weight+";font-size:"+s.size+"px;letter-spacing:"+s.tracking+"px";' +
        'var sp=document.createElement("span");sp.textContent=c;d.appendChild(sp);document.body.appendChild(d);adv.push(Math.round(sp.getBoundingClientRect().width));' +
        'cv.font=s.weight+" "+s.size+"px "+s.face;var m=cv.measureText(c);if(c!==" "){asc=Math.max(asc,m.actualBoundingBoxAscent);desc=Math.max(desc,m.actualBoundingBoxDescent);}});' +
        'out[s.name]={adv:adv,asc:asc,desc:desc};});var o=document.createElement("div");o.textContent="MEASURE"+JSON.stringify(out)+"END";document.body.appendChild(o);});' +
        '</script></body>';
    const file = path.join(tmp, 'fonts.html');
    fs.writeFileSync(file, page);
    return dump('file:///' + file.replace(/\\/g, '/'), tmp);
}

/* ---- path helpers ---- */
function nearestT(pieces, x, y) {
    const pts = flatten(pieces, 0.5), cum = measure(pts), total = cum[cum.length - 1];
    let best = Infinity, bt = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
        const ax = pts[i][0], ay = pts[i][1], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay, l2 = dx * dx + dy * dy;
        if (!l2) continue;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        const d2 = (ax + u * dx - x) ** 2 + (ay + u * dy - y) ** 2;
        if (d2 < best) { best = d2; bt = (cum[i] + u * Math.sqrt(l2)) / total; }
    }
    return bt;
}
const lengthOf = (pieces) => { const c = measure(flatten(pieces, 0.5)); return c[c.length - 1]; };

/* ---- the theme ---- */
function build(opts) {
    const src = opts.dir;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-' + opts.id + '-'));

    /* fonts: Archivo (OFL), the mockup's subset; wdth 108 as a static
     * instance (the build's atlas page sets no font-stretch) */
    const V = opts.variant;
    const FD = opts.fontDir || 'fonts/';
    const FONTS = V.fonts(FD + 'Archivo-wdth108.woff2', FD + 'Archivo.woff2');
    const fm = measureFonts(src, FONTS, tmp);
    Object.keys(FONTS).forEach((k) => {
        const f = FONTS[k], m = fm[k];
        f.adv = m.adv;
        const asc = Math.ceil(m.asc), desc = Math.ceil(m.desc);
        f.cell = [Math.max.apply(null, m.adv) + 4, asc + desc + 4];
        /* the build centres a line box of the cell's height: the baseline
         * sits at h/2 + (ascent - descent)/2 (Archivo: 0.878, 0.210 em) + dy */
        f.base = asc + 2;
        f.dy = Math.round(f.base - (f.cell[1] / 2 + 0.334 * f.size));
    });

    const M = dump('file:///' + path.join(src, 'art.html').replace(/\\/g, '/') + '#measure', tmp);
    const S = M.spans;

    /* ---- the two slanted scales: one field, the tach its mirror ----
     * The field's path runs 1 px outside the fine inner trace (31 px in from
     * the edge, horizontally, as the mockup translates its paths), so the
     * gauge's glow can draw the lit trace (white over d 0..2). d > 0 inward. */
    const REF = (31 * C - 1) / C;           /* horizontal offset of the path */
    const edgeX = (y) => 430 - (178 - Math.abs(y - 320) * K);
    /* the side point rounded (radius FILLET): past a sharp vertex every
     * pixel outside it is at one t, so the needle there would light the whole
     * corner; round, t turns with the angle (the logic narrows the needle
     * there: it widens with the radius) */
    const FILLET = 10, SLOPE = Math.atan(178 / 290) * 180 / Math.PI;
    const vx = 252 + REF, fcx = vx + FILLET / Math.sin((90 - SLOPE) * Math.PI / 180);
    const tan = (a) => [R2(fcx + FILLET * Math.cos(a * Math.PI / 180)), R2(320 + FILLET * Math.sin(a * Math.PI / 180))];
    const scalePath = [['M', R2(430 + REF), 610], ['L'].concat(tan(180 - SLOPE)), ['A', R2(fcx), 320, FILLET, R2(180 - SLOPE), R2(180 + SLOPE)], ['L', R2(430 + REF), 30]];
    const ref = 31 * C - 1;                 /* the path's perpendicular distance in from the edge */
    const D = (edge) => R2(edge - ref);     /* perpendicular distance from the edge -> field d */
    const band = [D(11 * C - 9), D(11 * C + 9)];   /* 18 wide, 11 in */
    const tint = [D(54 * C - 17), D(54 * C + 17)]; /* 34 wide, 54 in */
    const needleD = [D(0), D(84)];

    const SX0 = V.scaleX0 || 254;
    const scaleRect = [SX0, 28, Math.ceil(430 + REF + needleD[1] * C + 3) - SX0, 610 - 28];
    const scaleSpec = { path: scalePath, inward: -1, rect: scaleRect, maxd: Math.ceil(needleD[1]) + 1, ends: false };
    const L = lengthOf(scalePath);

    /* ---- the numerals: their own field (the tach's mirrored), a path NOFF
     * px outside the edge with the numerals inward of it and the ticks past
     * its reach. The layer brightens the art's dim numerals to white where
     * the band has reached (u_look.y); the glow, minus as much ground, keeps
     * the ground as it is. ---- */
    const NOFF = 96;
    const numPath = [['M', 430 - NOFF, 622], ['L', R2(252 - NOFF), 320], ['L', 430 - NOFF, 18]];
    const nums = M.numerals.map((n) => {
        const x0 = n.side < 0 ? n.x : W - n.x - n.w;
        return { side: n.side, v: n.v, x0: Math.floor(x0), x1: Math.ceil(x0 + n.w), y0: Math.floor(n.y - 23), y1: Math.ceil(n.y + 1) };
    });
    const nx0 = Math.min.apply(null, nums.map((n) => n.x0)) - 1, nx1 = Math.max.apply(null, nums.map((n) => n.x1)) + 1;
    const ny0 = Math.min.apply(null, nums.map((n) => n.y0)) - 1, ny1 = Math.max.apply(null, nums.map((n) => n.y1)) + 1;
    const numRect = [nx0, ny0, nx1 - nx0, ny1 - ny0];
    /* the ticks' nearest end (5 px out) sets the reach */
    const NUM_MAXD = Math.floor((NOFF * C) - 20 - 2);
    const numSpec = { path: numPath, inward: -1, rect: numRect, maxd: NUM_MAXD, ends: true };
    const nf = makeField(numSpec);
    nums.forEach((n) => {
        n.t0 = 1; n.t1 = 0;
        for (let y = n.y0; y < n.y1; y++) for (let x = n.x0; x < n.x1; x++) {
            const o = ((y - ny0) * numRect[2] + (x - nx0)) * 4;
            if (!nf.rgba[o + 3]) { n.miss = (n.miss || 0) + 1; continue; }
            if (nf.rgba[o + 2] - 128 < 0) n.out = (n.out || 0) + 1;
            const t = (nf.rgba[o] * 256 + nf.rgba[o + 1]) / 65535;
            n.t0 = Math.min(n.t0, t); n.t1 = Math.max(n.t1, t);
        }
    });
    /* lit up to here when numeral k is the last reached: between it and the next */
    const dimFrom = (side) => {
        const list = nums.filter((n) => n.side === side).sort((a, b) => a.v - b.v);
        list.forEach((n, i) => {
            if (n.out) console.warn('numeral ' + n.v + ': ' + n.out + ' px outward of its path');
            if (i + 1 < list.length && n.t1 >= list[i + 1].t0) console.warn('numerals ' + n.v + ' and ' + list[i + 1].v + ' overlap along the path');
        });
        return list.map((n, i) => [n.v, i + 1 < list.length ? R4((n.t1 + list[i + 1].t0) / 2) : 1]);
    };
    /* where the mockup's band (11 in) and trace (31 in) stand at a fraction f
     * of the scale: the same height on each translated path */
    const mapF = (dx) => {
        const out = [];
        for (let i = 0; i <= 100; i++) {
            const f = i / 100, y = 610 - f * 580;
            out.push([R4(f), R4(nearestT(scalePath, edgeX(y) + dx, y))]);
        }
        return out;
    };
    const bandMap = mapF(11), traceMap = mapF(31);
    const bandStart = R4(nearestT(scalePath, 441, 610));
    /* the band's outer corner at the top edge: lit no further, or it pokes above the hexagon */
    const bandMax = R4(nearestT(scalePath, 430 + 0.5 / C, 30));

    /* ---- slanted fluid bars: fuel (92 in) up, across the top, battery (216 in) down; oil and coolant mirror them ---- */
    const barCx = (y, off) => 252 + (y - 320) * K + off + 5;
    const barsPath = [['M', R2(barCx(590, 92)), 590], ['L', R2(barCx(424, 92)), 424], ['L', R2(barCx(424, 216)), 424], ['L', R2(barCx(590, 216)), 590]];
    const barsLen = lengthOf(barsPath), barLen = Math.hypot(166, 166 * K);
    const barsRect = [404, 420, 242, 170];
    const barHalf = R2(5 * C);

    /* ---- text layers ----
     * single: the build lays the text out (align); multi: the logic places
     * several readings in one layer (params.fonts, params.text) */
    const layerY = (font, baseline) => Math.round(baseline - FONTS[font].base);
    const text = (name, font, baseline, x, w, color, extra) => Object.assign({ name, shader: 'text', font, x: Math.round(x), y: layerY(font, baseline),
        w: Math.round(w), cells: 16, align: 'left', uniforms: { u_color: color || COL.text } }, extra || {});
    const wOf = (font, s) => s.split('').reduce((n, c) => n + FONTS[font].adv[Math.max(0, FONTS[font].glyphs.indexOf(c))], 0);
    const TEXT = {};   /* layer -> its x, for the logic's placements in layer coordinates */
    const tl = (name, font, baseline, x0, x1, color, extra) => { TEXT[name] = { x: Math.round(x0), w: Math.round(x1 - x0), font }; return text(name, font, baseline, x0, x1 - x0, color, extra); };

    const T = (f, extra) => Object.assign({ u_val: [0, 0, 2, 1], u_seg: [0, 0, 0, 1], u_glow: COL.none, u_needle: COL.none, u_look: [0.25, 0, 2, 0] }, f, extra || {});
    /* a side's three layers: tint and trace (on the art), band and needle, numerals */
    const scaleLayers = (pre, fieldName, numField, colBand, colTint, tintA, traceRgb) => [
        { name: pre + 'Tint', shader: 'gauge', field: fieldName, uniforms: T({ u_band: [tint[0], tint[1], 0, 0], u_shape: [4, 0, 0, 1],
            u_fill: colTint.slice(0, 3).concat([tintA]), u_red: colTint.slice(0, 3).concat([tintA]), u_glow: (traceRgb || COL.text.slice(0, 3)).concat([4]) }) },
        { name: pre + 'Band', shader: 'gauge', field: fieldName, art: false, uniforms: T({ u_band: [band[0], band[1], needleD[0], needleD[1]], u_shape: [1, 3.5, 0, 0],
            u_fill: colBand, u_red: colBand, u_needle: COL.text, u_seg: [0, 0, bandStart, 1] }) },
        { name: pre + 'Num', shader: 'gauge', field: numField, uniforms: T({ u_band: [0, 0, 0, 0], u_shape: [NUM_MAXD + 1, 0, 0, 1],
            u_fill: COL.none, u_red: COL.none, u_glow: COL.ground.slice(0, 3).map((v) => R4(-0.93 * v)).concat([1]), u_look: [0, 0.93, 0.01, 0] }) },
    ];
    /* the slanted bars: the first two on the left (up, then down the path), the others their mirror */
    const barLayers = (names, colors) => names.map((n, i) => ({ name: n, shader: 'gauge', field: i < 2 ? 'bars' : 'barsR', art: false,
        uniforms: T({ u_val: [i % 2, 0, 2, 1], u_band: [-barHalf, barHalf, 0, 0], u_shape: [1, 0, 0, 0], u_fill: colors[i], u_red: colors[i], u_seg: [0, 0, i % 2, 1] }) }));
    /* a horizontal bar as a row of thin lights, no field (the logic's hbar()) */
    const hbar = (name, x, y, w, h, cell, color) => ({ name, shader: 'leds', x, y, w, h, uniforms: { u_led: [Math.round(w / cell), 0, 0, 0],
        u_geom: [0, 0, cell, h], u_split: [999, 999, 0, 0], u_lean: [0, 0, 0, 0], u_c0: color, u_c1: color, u_c2: color, u_off: COL.none } });
    const mask = (name, x, y, w, h, color) => ({ name, shader: 'rect', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
        uniforms: { u_shape: [0, 0, 0, 0], u_color: color } });

    const part = V.parts({ FONTS, S, M, COL, text, tl, T, wOf, scaleLayers, barLayers, hbar, mask, mapF, R2, R4, needleD, ref });
    const layers = part.layers;
    const at = part.at;
    Object.keys(at).forEach((k) => { at[k] = R2(at[k]); });

    const fontsOut = {};
    Object.keys(FONTS).forEach((k) => { fontsOut[k] = { glyphs: FONTS[k].glyphs, adv: FONTS[k].adv, cellW: FONTS[k].cell[0] }; });

    const spec = {
        id: opts.id, title: opts.title, family: 'lci1', mode: V.mode, version: 2, bottom: 646,
        signals: part.signals,
        params: Object.assign({
            maxMph: 180, maxRpm: 7000,
            bandMap, traceMap, bandMax, bandStart,
            /* the rounded side point along the path (0..1): the needle narrows there */
            corner: [R4(nearestT(scalePath, ...tan(180 - SLOPE))), R4(nearestT(scalePath, ...tan(180 + SLOPE)))], cornerNeedle: R2(3.5 * FILLET / (FILLET - band[0])),
            litMph: dimFrom(-1), litRpm: dimFrom(1),
            bars: { len: R2(barsLen), bar: R2(barLen) },
            fuelMin: 0.02,
            at, text: TEXT, fonts: fontsOut, colors: COL,
        }, part.params),
        fonts: {},
        paths: Object.assign({
            speed: scaleSpec,
            tach: { mirror: 'speed' },
            nums: numSpec,
            numsR: { mirror: 'nums' },
            bars: { path: barsPath, inward: 1, rect: barsRect, maxd: 6, ends: false },
            barsR: { mirror: 'bars' },
        }, part.paths || {}),
        layers,
    };
    Object.keys(FONTS).forEach((k) => {
        const f = FONTS[k];
        spec.fonts[k] = { file: f.file, weight: f.weight, size: f.size, cell: f.cell, dy: f.dy, glyphs: f.glyphs };
        if (f.tracking) spec.fonts[k].tracking = f.tracking;
    });

    const json = JSON.stringify(spec, null, 1)
        .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']');
    fs.writeFileSync(path.join(src, 'theme.src.json'), json + '\n');
    const assets = Object.keys(spec.paths).filter((k) => !spec.paths[k].mirror).length + Object.keys(FONTS).length + 1;
    console.log(opts.id + ': ' + (layers.length + 1) + ' layers, ' + assets + ' assets; scale rect ' + scaleRect + ' maxd ' + scaleSpec.maxd +
        '; numerals rect ' + numRect + ' maxd ' + NUM_MAXD + '; lit mph ' + JSON.stringify(spec.params.litMph) + ' rpm ' + JSON.stringify(spec.params.litRpm));
    return spec;
}

/* ---- Sport (lci1) ---- */
const SPORT = {
    mode: 'sport',
    fonts: (F108, F100) => ({
        big: { file: F108, weight: 600, size: 112, tracking: -2.24, glyphs: '0123456789-NRPDS ' },
        val: { file: F108, weight: 600, size: 44, glyphs: '0123456789.-−+ ' },
        psi: { file: F108, weight: 600, size: 36, glyphs: '0123456789- ' },
        v24: { file: F108, weight: 600, size: 24, glyphs: '0123456789- ' },
        sub: { file: F100, weight: 500, size: 22, glyphs: '0123456789 -−+.°CmiSystehp' },
        label: { file: F100, weight: 600, size: 18, tracking: 1.44, glyphs: 'ELCTRIOVNGhp ' },
        clock: { file: F108, weight: 500, size: 32, glyphs: '0123456789:- ' },
    }),
    parts(c) {
        const { FONTS, S, COL, text, tl, T, R2, R4 } = c;
        /* the gear box: its outline (red at the shift point) and the two
         * upshift chevrons, one path: a lead-in, chevron, a connector, chevron
         * (segments with gaps light just the chevrons), then the outline */
        const leg = Math.hypot(14, 16), CH = 2 * leg, GAP = Math.hypot(28, 18), LEAD = GAP / 2;
        const gearPath = [['M', R2(1498 - LEAD * 14 / leg), R2(300 + LEAD * 16 / leg)], ['L', 1498, 300], ['L', 1512, 284], ['L', 1526, 300],
            ['L', 1498, 318], ['L', 1512, 302], ['L', 1526, 318],
            ['L', 1582, 320], ['L', 1542, 254], ['L', 1334, 254], ['L', 1320, 268], ['L', 1320, 386], ['L', 1542, 386], ['L', 1582, 320]];
        const gearLen = lengthOf(gearPath);
        const chevEnd = R4((LEAD + 2 * CH + GAP) / gearLen);
        const outlineStart = R4(lengthOf(gearPath.slice(0, 8)) / gearLen);
        const layers = [].concat(
            c.scaleLayers('speed', 'speed', 'nums', COL.ice, COL.ice, 0.38),
            c.scaleLayers('tach', 'tach', 'numsR', COL.red, COL.redTint, 0.94),
            [
                /* shift lights: 9 a side of 40 x 18 on a 46 pitch from x 532, filling from the ends */
                { name: 'shift', shader: 'leds', x: 529, y: 39, w: 862, h: 18, uniforms: { u_led: [18, 0, 0, 1], u_geom: [0, 0, 40, 18],
                    u_split: [4, 7, 0, 0], u_lean: [0, 34, 0, 0], u_c0: COL.text, u_c1: COL.amber, u_c2: COL.red, u_off: COL.track } },
                { name: 'gearOutline', shader: 'gauge', field: 'gear', art: false, uniforms: T({ u_val: [1, 0, 2, 1], u_band: [-1.5, 1.5, 0, 0], u_shape: [1, 0, 0, 0],
                    u_fill: COL.none, u_red: COL.none, u_seg: [0, 0, outlineStart, 1] }) },
                { name: 'chevrons', shader: 'gauge', field: 'gear', art: false, uniforms: T({ u_val: [chevEnd, 0, 2, 1], u_band: [-2, 2, 0, 0], u_shape: [1, 0, 0, 0],
                    u_fill: COL.none, u_red: COL.none, u_seg: [2, R2(GAP), 0, R4(2 * (CH + GAP) / gearLen)] }) },
                /* boost 470..630 (rows 178..183); engine 950 leftward to 730 and electric 970 rightward (rows 172..179) */
                c.hbar('boostBar', 470, 178, 160, 6, 2, COL.text),
                c.hbar('engBar', 730, 172, 220, 8, 2, COL.text),
                c.hbar('eleBar', 970, 172, 220, 8, 2, COL.ice),
            ],
            c.barLayers(['fuelBar', 'batBar', 'oilBar', 'coolBar'], [COL.text, COL.ice, COL.text, COL.text]),
            [
                { name: 'gDot', shader: 'rect', x: 1426, y: 136, w: 12, h: 12, uniforms: { u_shape: [0, 0, 6, 0], u_color: COL.text } },
                /* tyres 20 x 54 at x 882 and 1018: two lights a row, a 116 px gap */
                { name: 'tyresF', shader: 'leds', x: 882, y: 270, w: 156, h: 54, uniforms: { u_led: [2, 2, 0, 0], u_geom: [0, 0, 20, 54],
                    u_split: [1, 2, 4, 0], u_lean: [0, 116, 0, 0], u_c0: COL.tyre, u_c1: COL.tyre, u_c2: COL.tyre, u_off: COL.tyre } },
                { name: 'tyresR', shader: 'leds', x: 882, y: 456, w: 156, h: 54, uniforms: { u_led: [2, 2, 0, 0], u_geom: [0, 0, 20, 54],
                    u_split: [1, 2, 4, 0], u_lean: [0, 116, 0, 0], u_c0: COL.tyre, u_c1: COL.tyre, u_c2: COL.tyre, u_off: COL.tyre } },
                /* the art's M, hidden when the gearbox is not in M */
                c.mask('modeMask', Math.floor(S.mM.bx) - 1, 352 - 40, Math.ceil(S.mM.bw) + 2, 43, COL.box),
            ],
            [
                text('speedText', 'big', 352, 584 - 3 * FONTS.big.cell[0], 3 * FONTS.big.cell[0], COL.text, { cells: 3, align: 'right' }),
                tl('gearText', 'big', 352, 1328, 1540),
                tl('val160', 'val', 160, 466, 1380),
                tl('val156', 'val', 156, 820, 1110),
                tl('eleUnit', 'label', 156, 980, 1130, COL.text2),
                text('eleLabel', 'label', 106, 980, 160, COL.text2, { cells: 10, text: 'ELECTRIC' }),
                tl('sysWords', 'sub', 214, 850, 1070, COL.text2),
                tl('sysNum', 'v24', 214, 900, 1020),
                tl('psiF', 'psi', 300, 780, 1110),
                tl('psiR', 'psi', 486, 780, 1110),
                tl('tempF', 'sub', 326, 780, 1130, COL.text2),
                tl('tempR', 'sub', 512, 780, 1130, COL.text2),
                tl('fluids', 'v24', 490, Math.floor(S.mFuel.x0) - 20, Math.ceil(Math.max(S.mOil.x1, S.mCool.x1)) + 2),
                tl('ranges', 'sub', 518, Math.floor(S.sFuel.x0) - 2, Math.ceil(S.sBat.x0) + 90, COL.text2),
                text('clock', 'clock', 596, 64, 5 * FONTS.clock.cell[0], COL.text, { cells: 5, text: '' }),
                tl('outside', 'sub', 624, 64, 200, COL.dim),
                tl('odo', 'sub', 624, 1700, 1856, COL.dim),
            ]);
        return {
            layers,
            at: {
                boost: S.mBoost.x0, gEnd: S.mG.x1, engEnd: S.mEng.x1, ele: S.mEle.x0, gearM: S.mGear.x0, gearMid: 1420,
                psiFLEnd: S.mPFL.x1, psiFR: S.mPFR.x0, psiRLEnd: S.mPRL.x1, psiRR: S.mPRR.x0, tempLEnd: 862, tempR: 1058,
                fuelEnd: S.mFuel.x1, batEnd: S.mBat.x1, oilEnd: S.mOil.x1, coolEnd: S.mCool.x1, rangeFuel: S.sFuel.x0, rangeBat: S.sBat.x0,
                sysMid: 960, outside: 64, odoEnd: 1856,
            },
            signals: ['kmh', 'rpm', 'gear', 'gearMode', 'throttle', 'engineHp', 'elecHp', 'boostBar', 'gLat', 'gLon', 'socPct', 'evRangeKm',
                'fuelPct', 'rangeKm', 'oilC', 'coolantC', 'tyres', 'outsideC', 'odoKm', 'clock'],
            params: {
                shiftFrom: 4600, shiftAt: 6000, upCue: 5600,
                gear: { chevEnd, outlineStart },
                power: { engMaxHp: 390, eleMaxHp: 110, boostMax: 1.5, regenCell: 8 },
                gRing: { cx: 1432, cy: 142, r: 36, max: 1.2 },
                tyre: { cold: 36, hot: 68 },
                oilRed: 132, coolRed: 106,
            },
            paths: { gear: { path: gearPath, inward: 1, rect: [1317, 251, 268, 138], maxd: 3, ends: false } },
        };
    },
};

if (require.main === module) {
    build({ dir: __dirname, id: 'lci1', title: 'LCI inspired 1', variant: SPORT });
}
module.exports = { build, SPORT, COL, hex, K, C, lengthOf, nearestT };
