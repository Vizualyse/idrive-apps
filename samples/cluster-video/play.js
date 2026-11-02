// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A tech-demo player: raw I420 frames from a file as a cluster-render
 * video layer on the instrument cluster. Nothing is decoded here; make the
 * file on a PC, for example:
 *   ffmpeg -ss 150 -t 30 -i input.mkv -an -sn \
 *     -vf "scale=480:270,fps=15,format=yuv420p" -f rawvideo clip.yuv
 *
 * A tech demo, meant for a parked car. On the HUD it keeps to the band
 * between its clipped top and its speed (25 % to 65 % of the height). It ends
 * after --seconds (default 30), at
 * the end of the file unless --loop, and on Ctrl-C; its layer goes with it.
 *
 * On the unit (Node 8), beside cluster_render_client.js:
 *   node play.js --file clip.yuv [--size 480x270] [--fps 15] [--target map|panel|hud] [--seconds N] [--loop]
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

const APP = 'vizualyse_video';
const SIZES = { map: [1088, 480], panel: [1920, 720], hud: [800, 480] };
const HUD_BAND = [0.25, 0.65];

function parse(argv) {
    const a = { socket: DEFAULT_PATH, target: 'map', size: [480, 270], fps: 15, seconds: 30, loop: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--file') a.file = argv[++i];
        else if (t === '--size') a.size = String(argv[++i]).split('x').map(Number);
        else if (t === '--fps') a.fps = Number(argv[++i]);
        else if (t === '--target') a.target = argv[++i];
        else if (t === '--seconds') a.seconds = Number(argv[++i]);
        else if (t === '--socket') a.socket = argv[++i];
        else if (t === '--loop') a.loop = true;
        else a.bad = t;
    }
    const w = a.size[0], h = a.size[1];
    if (a.bad || !a.file || !SIZES[a.target] || !(w >= 16 && h >= 16 && w % 2 === 0 && h % 2 === 0) ||
        !(a.fps > 0 && a.fps <= 30) || !(a.seconds > 0)) {
        console.error('usage: node play.js --file clip.yuv [--size WxH] [--fps 1-30] [--target map|panel|hud] [--seconds N] [--loop]');
        process.exit(2);
    }
    return a;
}

/* I420 (Y plane, U plane, V plane) to the renderer's 4:2:0 atlas: the Y
 * plane, then each chroma row as its U half followed by its V half. */
function atlas(i420, w, h, out) {
    const ySize = w * h, cw = w / 2, ch = h / 2, cSize = cw * ch;
    i420.copy(out, 0, 0, ySize);
    for (let y = 0; y < ch; y++) {
        const row = ySize + y * w;
        i420.copy(out, row, ySize + y * cw, ySize + (y + 1) * cw);
        i420.copy(out, row + cw, ySize + cSize + y * cw, ySize + cSize + (y + 1) * cw);
    }
    return out;
}

/* The largest rect of the clip's aspect inside the target, centred. */
function fit(W, H, w, h) {
    const s = Math.min(W / w, H / h), dw = Math.round(w * s), dh = Math.round(h * s);
    return { x: Math.round((W - dw) / 2), y: Math.round((H - dh) / 2), w: dw, h: dh };
}

function main() {
    const args = parse(process.argv.slice(2));
    const w = args.size[0], h = args.size[1], W = SIZES[args.target][0], H = SIZES[args.target][1];
    const frameSize = w * h * 3 / 2;
    const total = Math.floor(fs.statSync(args.file).size / frameSize);
    if (!total) { console.error(args.file + ': smaller than one ' + w + 'x' + h + ' frame'); process.exit(1); }

    const log = (s) => console.log(new Date().toISOString() + ' ' + s);
    const cr = new ClusterRender(APP, args.socket);
    /* On the HUD, the band between its clipped top and its speed. */
    const top = args.target === 'hud' ? Math.round(H * HUD_BAND[0]) : 0;
    const bandH = args.target === 'hud' ? Math.round(H * (HUD_BAND[1] - HUD_BAND[0])) : H;
    const r = fit(W, bandH, w, h);
    r.y += top;
    const vid = cr.video({ target: args.target, x: r.x, y: r.y, w: r.w, h: r.h, vw: w, vh: h, fps: args.fps });
    log(APP + ': ' + total + ' frames of ' + w + 'x' + h + ' at ' + args.fps + ' fps, shown ' + r.w + 'x' + r.h +
        ' at ' + r.x + ',' + r.y + ' on ' + args.target + ' for at most ' + args.seconds + ' s');

    cr.on('ready', () => log('ready: backend ' + cr.backend));
    cr.on('layer', (ref, state, reason) => log('layer ' + state + (reason ? ': ' + reason : '')));
    cr.on('target', (t, state, holder, reason) => { if (t === args.target) log('target ' + t + ' ' + state + (reason ? ': ' + reason : '')); });
    cr.on('budget', (cap, max, reason) => log('budget ' + cap + ' of ' + max + ' KB/s' + (reason ? ': ' + reason : '')));
    cr.on('refused', (op, ref, reason) => log('refused ' + op + (reason ? ': ' + reason : '')));

    const fd = fs.openSync(args.file, 'r'), raw = Buffer.alloc(frameSize), out = Buffer.alloc(frameSize);
    let n = 0, sent = 0, missed = 0;
    const started = Date.now();
    const end = (why) => {
        clearInterval(timer);
        log('ending: ' + why + '; ' + sent + ' frames sent, ' + missed + ' not sent (not connected)');
        cr.close(); fs.closeSync(fd); process.exit(0);
    };
    const timer = setInterval(() => {
        if (n >= total) { if (!args.loop) return end('end of file'); n = 0; }
        fs.readSync(fd, raw, 0, frameSize, n * frameSize);
        if (cr.frame(vid, atlas(raw, w, h, out), n + 1)) sent++; else missed++;
        n++;
        if (sent && sent % (args.fps * 5) === 0) log('frame ' + n + '/' + total + ', ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
    }, 1000 / args.fps);

    process.on('SIGINT', () => end('SIGINT'));
    process.on('SIGTERM', () => end('SIGTERM'));
    setTimeout(() => end(args.seconds + ' s elapsed'), args.seconds * 1000);
    cr.connect();
}

main();
