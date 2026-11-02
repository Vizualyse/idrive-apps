// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan; glyph and dial drawing adapted from
// native/cluster-render/js/showcase.js, Copyright (C) 2026 Robert Nisipeanu.
/**
 * A sample cluster/HUD app through cluster-render (native/cluster-render/PROTOCOL.md):
 * a needle gauge showing the head unit's CPU load, and a digital readout
 * "HH:MM  CPU  NN" under it. The data is the unit's own /proc/stat, so it
 * needs no vehicle API; swap readValue() for your own source.
 *
 * It ends by itself after --seconds (default 60), and on Ctrl-C; its layers
 * go with it.
 *
 * On the unit (Node 8): copy this file and
 * native/cluster-render/js/cluster_render_client.js into one directory and run
 * it as root or a member of group tm_oap_app:
 *   node gauge.js [--target map|hud|panel] [--seconds N] [--socket PATH]
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadClient() {
    const here = path.join(__dirname, 'cluster_render_client.js');
    const repo = path.join(__dirname, '..', '..', 'native', 'cluster-render', 'js', 'cluster_render_client.js');
    return require(fs.existsSync(here) ? here : repo);
}
const { ClusterRender, DEFAULT_PATH } = loadClient();

const APP = 'vizualyse_gauge';
const SIZES = { panel: [1920, 720], map: [1088, 480], hud: [800, 480] };
const SWEEP = 120;          /* the needle runs from -SWEEP (0 %) to +SWEEP (100 %) degrees */
const CELLS = 16;           /* characters in the readout */

/* ---- the reading --------------------------------------------------------- */

/* CPU busy time as 0..100 since the last call, from the `cpu` line of
 * /proc/stat (idle and iowait count as not busy). */
let lastCpu = null;
function readValue() {
    try {
        const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        const total = f.reduce((a, b) => a + b, 0), idle = f[3] + (f[4] || 0);
        const prev = lastCpu;
        lastCpu = { total: total, idle: idle };
        if (!prev || total <= prev.total) return 0;
        return Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)))));
    } catch (e) {
        return 0;
    }
}

/* ---- drawing ------------------------------------------------------------- */

const HIGHP = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

/* CELLS cells of 16x32 seven-segment glyphs; u_text holds the glyph codes,
 * 4 to a vec4. */
const TEXT_FS = `#version 100
${HIGHP}uniform sampler2D u_font;
uniform vec4 u_text[4];
varying vec2 v_uv;
float code(float cell) {
    float slot = floor(cell / 4.0), lane = cell - slot * 4.0;
    vec4 v = u_text[0];
    for (int i = 1; i < 4; i++)
        if (float(i) == slot) v = u_text[i];
    return lane < 0.5 ? v.x : lane < 1.5 ? v.y : lane < 2.5 ? v.z : v.w;
}
void main() {
    float x = v_uv.x * ${CELLS}.0;
    float ink = texture2D(u_font, vec2((code(floor(x)) + fract(x)) / 32.0, v_uv.y)).r;
    vec4 bg = vec4(0.02, 0.03, 0.05, 0.6);
    gl_FragColor = vec4(mix(bg.rgb, vec3(0.2, 0.85, 1.0), ink), max(bg.a, ink));
}`;

const GLYPHS = '0123456789AbCdEFHLPrUnot-: .hSyu';
const SEGMENTS = {
    0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg',
    9: 'abcdfg', A: 'abcefg', b: 'cdefg', C: 'adef', d: 'bcdeg', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def',
    P: 'abefg', r: 'eg', U: 'bcdef', n: 'ceg', o: 'cdeg', t: 'defg', '-': 'g', ':': ':', '.': '.', h: 'cefg',
    S: 'afgcd', y: 'bcdfg', u: 'cde', ' ': '',
};
const STROKES = {
    a: [5, 2, 6, 3], b: [11, 5, 3, 9], c: [11, 17, 3, 9], d: [5, 26, 6, 3], e: [2, 17, 3, 9], f: [2, 5, 3, 9],
    g: [5, 14, 6, 3], ':': [6, 9, 4, 4, 6, 19, 4, 4], '.': [6, 25, 4, 4],
};

/* The glyph atlas: 32 glyphs of 16x32 in one 512x32 R8 image. */
function font() {
    const w = 16 * GLYPHS.length, px = Buffer.alloc(w * 32);
    GLYPHS.split('').forEach((ch, cell) => SEGMENTS[ch].split('').forEach((s) => {
        const r = STROKES[s];
        for (let k = 0; k < r.length; k += 4)
            for (let y = r[k + 1]; y < r[k + 1] + r[k + 3]; y++)
                px.fill(255, y * w + cell * 16 + r[k], y * w + cell * 16 + r[k] + r[k + 2]);
    }));
    return px;
}

/* The glyph codes of `s`, padded or cut to CELLS. */
function codes(s) {
    const t = (s + ' '.repeat(CELLS)).slice(0, CELLS);
    return t.split('').map((ch) => Math.max(0, GLYPHS.indexOf(ch)));
}

/* RGBA pixels of a w x h image from f(x, y) -> [r, g, b, a] or null. */
function paint(w, h, f) {
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const c = f(x + 0.5, y + 0.5);
            if (c) px.set(c, (y * w + x) * 4);
        }
    return px;
}

/* Radius and degrees clockwise from up, about (c, c). */
function polar(x, y, c) {
    const dx = x - c, dy = y - c;
    return [Math.sqrt(dx * dx + dy * dy), Math.atan2(dx, -dy) * 180 / Math.PI];
}

/* A dial of radius R: ticks every 10 % over the sweep (amber past 70 %, red
 * past 90 %), a coloured arc, and a dark face. */
function dial(R) {
    const step = SWEEP * 2 / 10;
    return paint(2 * R, 2 * R, (x, y) => {
        const [r, a] = polar(x, y, R);
        const pct = (a + SWEEP) / (SWEEP * 2) * 100;
        const t = Math.round((a + SWEEP) / step) * step - SWEEP;
        const tone = pct > 90 ? [255, 50, 40, 255] : pct > 70 ? [255, 170, 0, 255] : [235, 240, 245, 255];
        if (r < R * 0.07) return [230, 230, 230, 255];
        if (Math.abs(a) <= SWEEP + 0.5) {
            if (r > R * 0.72 && r < R * 0.86 && Math.abs(t) <= SWEEP &&
                r * Math.abs(Math.sin((a - t) * Math.PI / 180)) < R * 0.012 + 1) return tone;
            if (r > R * 0.88 && r < R * 0.93) return [tone[0], tone[1], tone[2], 200];
        }
        if (r < R * 0.95) return [8, 12, 20, 170];
        return null;
    });
}

/* A needle pointing up, w x l, its pivot at (w/2, l - w/2). */
function needle(w, l) {
    return paint(w, l, (x, y) => {
        const half = (w / 2) * (0.3 + 0.7 * Math.min(y / (l - w / 2), 1));
        return Math.abs(x - w / 2) < half ? [255, 90, 20, 255] : null;
    });
}

/* ---- main ---------------------------------------------------------------- */

function parse(argv) {
    const a = { socket: DEFAULT_PATH, target: 'map', seconds: 60 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--socket') a.socket = argv[++i];
        else if (argv[i] === '--target') a.target = argv[++i];
        else if (argv[i] === '--seconds') a.seconds = Number(argv[++i]);
        else { a.bad = argv[i]; }
    }
    if (a.bad || !SIZES[a.target] || !(a.seconds > 0)) {
        console.error('usage: node gauge.js [--target map|hud|panel] [--seconds N] [--socket PATH]');
        process.exit(2);
    }
    return a;
}

function main() {
    const args = parse(process.argv.slice(2));
    const W = SIZES[args.target][0], H = SIZES[args.target][1], target = args.target;
    const log = (s) => console.log(new Date().toISOString() + ' ' + s);
    const cr = new ClusterRender(APP, args.socket);

    cr.on('ready', () => log('ready: backend ' + cr.backend + ', targets ' + cr.targets));
    cr.on('disconnected', () => log('disconnected'));
    cr.on('layer', (ref, state, reason) => log('layer ' + ref + ' ' + state + (reason ? ': ' + reason : '')));
    cr.on('target', (t, state, holder, reason) => log('target ' + t + ' ' + state + (reason ? ': ' + reason : '')));
    cr.on('refused', (op, ref, reason) => log('refused ' + op + ' ' + ref + (reason ? ': ' + reason : '')));

    /* The dial and needle, centred a little above the middle. */
    const R = Math.round(H * 0.36), cx = Math.round(W / 2), cy = Math.round(H * 0.42);
    const nw = 2 * Math.max(4, Math.round(R * 0.04)), nl = Math.round(R * 0.84);
    const face = cr.image({ target: target, x: cx - R, y: cy - R, w: 2 * R, h: 2 * R });
    cr.pixels(face, null, dial(R));
    const hand = cr.image({ target: target, z: 1, x: cx - nw / 2, y: cy - (nl - nw / 2), w: nw, h: nl,
        px: nw / 2, py: nl - nw / 2, sampling: 'bilinear', rotate: -SWEEP });
    cr.pixels(hand, null, needle(nw, nl));

    /* The readout under the dial. */
    const th = Math.round(H * 0.1), tw = Math.round(th * CELLS / 2);
    const atlas = cr.asset({ target: target, format: 'r8', w: 512, h: 32, sampling: 'bilinear' });
    cr.pixels(atlas, null, font());
    const text = cr.effect({ target: target, klass: 'overlay', x: Math.round((W - tw) / 2),
        y: Math.min(H - th - 8, cy + R + 10), w: tw, h: th, fs: TEXT_FS });
    cr.bind(text, 'u_font', atlas);

    const tick = () => {
        const v = readValue(), d = new Date(), two = (n) => ('0' + n).slice(-2);
        cr.set(hand, { rotate: -SWEEP + v / 100 * SWEEP * 2 });
        cr.uniform(text, 'u_text', codes(two(d.getHours()) + ':' + two(d.getMinutes()) + '  CPU ' + ('  ' + v).slice(-3)),
            { type: 'vec4' });
    };
    tick();
    const timer = setInterval(tick, 1000);

    const end = (why) => { log('ending: ' + why); clearInterval(timer); cr.close(); process.exit(0); };
    process.on('SIGINT', () => end('SIGINT'));
    process.on('SIGTERM', () => end('SIGTERM'));
    setTimeout(() => end(args.seconds + ' s elapsed'), args.seconds * 1000);

    log(APP + ' on ' + target + ' (' + W + 'x' + H + ') via ' + args.socket + ' for ' + args.seconds + ' s');
    cr.connect();
}

main();
