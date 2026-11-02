// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse-cast: plays a stream URL on the iDrive 7 instrument cluster or HUD,
 * with its sound through the car's speakers, controlled from a phone page.
 *
 * - A web page on the uplink's Wi-Fi address (the phone's hotspot), port
 *   8480, behind a token; the cluster shows its link as a QR code while idle.
 * - ffmpeg (bundled, static) reads the stream through proxy.js, which runs as
 *   the tool's internet uid; mgu-uplink routes only that uid through the
 *   phone. ffmpeg writes I420 frames (stdout) and S16LE 48 kHz audio (fd 3).
 * - Frames go to cluster-render as a video layer; audio to pcm_play.py
 *   (mgu-python), which plays it into SmartXbar's CarPlayMain source.
 *
 *   node server.js     (root: the render socket, ALSA, nftables)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const qrcode = require('./qrcode.js');
const firewall = require('./firewall.js');
const { ClusterRender } = require('./cluster_render_client.js');
const consoleOut = require('./console_out.js');
const { startControl } = require('./control.js');

const HERE = __dirname;
const STATE_DIR = process.env.CAST_STATE || '/var/opt/vizualyse-cast/state';
const PORT = Number(process.env.CAST_PORT) || 8480;
const PROXY_PORT = PORT + 1;
const INTERNET_UID = 12999;
const IFNAME = 'wlan0';
const FFMPEG = path.join(HERE, 'ffmpeg');
const PYTHON = '/var/opt/mgu-python/current/bin/python3';
const LEASE = '/run/mgu-uplink/lease.json';
const UPLINK_STATUS = '/run/mgu-uplink/status.json';

/* The central screen as a source: BMW's winston-grabber encodes it in
 * hardware (h264_msdk) at half size and sends MPEG-TS to a local UDP port,
 * which ffmpeg crops and scales like any other stream. */
const GRABBER = '/usr/bin/winston-grabber';
/* Each mirror takes the next of 8 local UDP ports: a new one never waits for
 * the one it replaces to let go of its port. */
const SCREEN_PORT = PORT + 2, SCREEN_PORTS = 8;
let screenSeq = 0;
const SCREEN = { W: 1920, H: 720 };
/* full size: the sharpest picture; the grabber runs at the mirror's own frame rate */
const GRAB = { w: 1920, h: 720, fps: 15 };
/* Crops of the central screen, in its own 1920x720 pixels; carplay is the
 * part right of CarPlay's dock at the cluster map's 2.27:1 (the phone page's
 * preview shows where it falls). */
const CROPS = {
    carplay: { x: 288, y: 0, w: 1632, h: 720, title: 'CarPlay map' },
    full: { x: 0, y: 0, w: 1920, h: 720, title: 'Whole screen' },
    /* Google Maps in CarPlay (dock on the right). Its parts, in screen pixels:
     * the direction banner, the arrival / time / distance readouts, and the
     * map around the car. A layout is columns side by side at one height,
     * each a stack of regions at one width. */
    /* For the cluster map: the map around the car fills the frame, the
     * direction card and the readouts card along the top, clear of the car,
     * which Google Maps draws low. */
    gmaps: { x: 0, y: 0, w: 1920, h: 720, title: 'Google Maps (cluster)', overlay: {
        /* the clean map (right of Google's buttons, left of its cards), down to
         * the screen's bottom so the street-name card under the car shows */
        base: { x: 125, y: 339, w: 985, h: 381 },
        /* both cards one height (`hf` of the frame's), each its own shape,
         * side by side as a pair centred on the top (`slot` 1 then 2), a
         * little below the edge */
        top: { x: 1112, y: 4, w: 650, h: 202, hf: 0.19, slot: 1 },
        bottom: { x: 1112, y: 576, w: 650, h: 140, hf: 0.19, slot: 2 },
    } },
    /* For the HUD's wide band: the banner over the readouts on the left, the
     * map (a wider, lower cut around the car) on the right. */
    gmapsHud: { x: 0, y: 0, w: 1920, h: 720, title: 'Google Maps (HUD)', columns: [[
        { x: 1112, y: 4, w: 650, h: 202 },
        { x: 1112, y: 576, w: 650, h: 140 },
    ], [
        { x: 120, y: 300, w: 960, h: 390 },
    ]] },
};

/* A layout's geometry fitted into W x H at `fill` of the room (the renderer
 * scales the layer up the rest of the way, keeping the upload small): the
 * frame { w, h }, each column's width and each region's size, all even, the
 * frame a multiple of 4 wide. Columns share one height; a region is `wf` of
 * its column's width (default 1), centred. */
function layoutSize(columns, W, H, fill) {
    const hu = columns.map((col) => col.reduce((n, r) => n + r.h * (r.wf || 1) / r.w, 0));
    const inv = hu.reduce((n, x) => n + 1 / x, 0);
    const h = even(Math.min(H * fill, W * fill / inv));
    const ws = hu.map((x) => even(h / x)), total = ws.reduce((m, n) => m + n, 0);
    ws[ws.length - 1] -= total - four(total);
    const cols = columns.map((col, j) => ({
        w: ws[j],
        regions: col.map((r) => { const rw = even(ws[j] * (r.wf || 1)); return { w: rw, h: even(r.h * rw / r.w) }; }),
    }));
    return { w: ws.reduce((m, n) => m + n, 0), h: h, cols: cols };
}

/* An overlay's frame: the target area's own shape at `fill` (upload), the
 * base cut to that shape around its centre (within the screen), the cards
 * their width fraction of the frame. */
function overlaySize(ov, W, H, fill) {
    const w = four(W * fill), h = even(H * fill), aspect = w / h, b = ov.base;
    let bw = b.w, bh = Math.round(b.w / aspect);
    if (bh > b.h) { bh = b.h; bw = Math.round(b.h * aspect); }
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const base = { x: Math.max(0, Math.round(cx - bw / 2)), y: Math.max(0, Math.min(SCREEN.H - bh, Math.round(cy - bh / 2))), w: bw, h: bh };
    const card = (r) => {
        if (r.box) { const cw = even(w * r.box[0]); return { r: r, w: cw, h: even(cw / r.box[1]) }; }
        if (r.hf) { const ch = even(h * r.hf); return { r: r, h: ch, w: even(r.w * ch / r.h) }; }
        const cw = even(w * r.wf); return { r: r, w: cw, h: even(r.h * cw / r.w) };
    };
    return { w: w, h: h, base: base, top: card(ov.top), bottom: card(ov.bottom) };
}

function overlayGraph(geo, k, fps, look) {
    /* x: slots 1 and 2 side by side, the pair centred with a gap; else a side or centred */
    const gap = even(geo.w * 0.02), pair = geo.top.w + gap + geo.bottom.w, left = Math.round((geo.w - pair) / 2);
    const ax = (r) => (r.slot === 1 ? String(left) : r.slot === 2 ? String(left + geo.top.w + gap)
        : r.align === 'left' ? '0' : r.align === 'right' ? 'W-w' : '(W-w)/2');
    const top = even(geo.h * 0.03), line = top + Math.max(geo.top.h, geo.bottom.h) / 2;
    const ay = (r) => (r.slot ? String(Math.round(line - (r === geo.top.r ? geo.top.h : geo.bottom.h) / 2))
        : r.at === 'top' ? String(top) : r === geo.top.r ? '0' : 'H-h');
    const cut = (r) => 'crop=' + even(r.w * k) + ':' + even(r.h * k) + ':' + even(r.x * k) + ':' + even(r.y * k);
    return ['[0:v]split=3[b][t][u]',
        '[b]' + cut(geo.base) + ',scale=' + geo.w + ':' + geo.h + ':flags=bicubic[m]',
        '[t]' + cut(geo.top.r) + ',scale=' + geo.top.w + ':' + geo.top.h + ':flags=bicubic[tc]',
        '[u]' + cut(geo.bottom.r) + ',scale=' + geo.bottom.w + ':' + geo.bottom.h + ':flags=bicubic[bc]',
        '[m][tc]overlay=' + ax(geo.top.r) + ':' + ay(geo.top.r) + '[m1]',
        '[m1][bc]overlay=' + ax(geo.bottom.r) + ':' + ay(geo.bottom.r) + ',fps=' + fps + (look ? ',' + look : '') + ',format=yuv420p[v]'].join(';');
}

/* The filter graph of a layout: each region cropped from the half-size grab
 * (k: grab pixels a screen pixel), scaled to its size and centred on black
 * in its column's width, each column stacked, the columns side by side, at
 * the frame's exact size. */
function layoutGraph(columns, geo, k, fps, look) {
    const parts = [], all = [];
    columns.forEach((col, j) => col.forEach((r, i) => all.push({ r: r, j: j, i: i })));
    parts.push('[0:v]split=' + all.length + all.map((a, n) => '[i' + n + ']').join(''));
    all.forEach((a, n) => {
        const r = a.r, cw = geo.cols[a.j].w, g = geo.cols[a.j].regions[a.i];
        parts.push('[i' + n + ']crop=' + even(r.w * k) + ':' + even(r.h * k) + ':' + even(r.x * k) + ':' + even(r.y * k) +
            ',scale=' + g.w + ':' + g.h + ':flags=bicubic' + (g.w < cw ? ',pad=' + cw + ':' + g.h + ':(ow-iw)/2:0:black' : '') +
            '[r' + a.j + '_' + a.i + ']');
    });
    columns.forEach((col, j) => {
        const ins = col.map((r, i) => '[r' + j + '_' + i + ']').join('');
        parts.push(ins + (col.length > 1 ? 'vstack=inputs=' + col.length + ',' : '') + 'scale=' + geo.cols[j].w + ':' + geo.h + '[c' + j + ']');
    });
    const cols = columns.map((c, j) => '[c' + j + ']').join('');
    parts.push(cols + (columns.length > 1 ? 'hstack=inputs=' + columns.length + ',' : '') +
        'scale=' + geo.w + ':' + geo.h + ',fps=' + fps + (look ? ',' + look : '') + ',format=yuv420p[v]');
    return parts.join(';');
}

/* The mirror's frame sizes: the cluster map at its own 2.27:1, the HUD as before. */
const MIRROR_SIZES = { map: { w: 544, h: 240 }, hud: { w: 480, h: 270 } };
/* On the cluster map the gauge surround fades the top and the bottom: a
 * mirror keeps to y 72-440 of its 480 (waze-on-cluster's safe area). */
const MIRROR_BANDS = { map: [0.08, 0.96] };
const GRAB_ENV = Object.assign({}, process.env, { XDG_RUNTIME_DIR: '/run/wayland' });

function even(n) { return Math.max(0, Math.round(n / 2) * 2); }
/* cluster-render takes a video at most this wide a multiple of 4. */
function four(n) { return Math.max(4, Math.floor(n / 4) * 4); }

/* A crop from the page or the app: a preset name, or x, y, w, h within the
 * screen (at least 64x36); null when it is neither. */
function normCrop(c) {
    if (!c) return Object.assign({ preset: 'carplay' }, CROPS.carplay);
    if (typeof c === 'string' || (c.preset && CROPS[c.preset] && c.x === undefined)) {
        const k = typeof c === 'string' ? c : c.preset;
        return CROPS[k] ? Object.assign({ preset: k }, CROPS[k]) : null;
    }
    const x = even(Number(c.x)), y = even(Number(c.y)), w = even(Number(c.w)), h = even(Number(c.h));
    if (![x, y, w, h].every(isFinite) || w < 64 || h < 36 || x + w > SCREEN.W || y + h > SCREEN.H) return null;
    return { preset: 'custom', x: x, y: y, w: w, h: h, title: 'Custom ' + w + 'x' + h + '+' + x + '+' + y };
}

/* Each output: the target, the frame size sent and its rate (within the
 * renderer's 5500 KB/s upload ceiling), and the part of the target used. */
const OUTPUTS = {
    map: { target: 'map', W: 1088, H: 480, w: 512, h: 288, fps: 15, band: null, title: 'Cluster map' },
    /* band: the part of the height the HUD shows clear of its clipped top and
     * the speed; xband: the part of the width its optics show. */
    hud: { target: 'hud', W: 800, H: 480, w: 480, h: 270, fps: 15, band: [0.25, 0.65], xband: [0.17, 0.83], title: 'HUD' },
    /* The central display through mgu-render: a frame file, not cluster-render's upload budget. */
    console: { console: true, w: 640, h: 360, fps: 15, title: 'Media console' },
    none: { title: 'Audio only' },
};

const log = (s) => console.log(new Date().toISOString() + ' ' + s);

/* ---- small helpers ------------------------------------------------------- */

function mkdirp(d) { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d, 0o700); } }

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

/* The token in the QR link: kept across restarts, so a saved link works. */
function token() {
    const f = path.join(STATE_DIR, 'token');
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{16}$/.test(t)) return t; } catch (e) { /* new */ }
    const t = crypto.randomBytes(8).toString('hex');
    mkdirp(STATE_DIR);
    fs.writeFileSync(f, t + '\n', { mode: 0o600 });
    return t;
}

/* The head unit's address on the phone's hotspot, or null. */
function uplinkIp() {
    const l = readJson(LEASE);
    if (l && l.ip) return l.ip;
    const ifs = os.networkInterfaces()[IFNAME] || [];
    const v4 = ifs.filter((a) => a.family === 'IPv4' && !a.internal)[0];
    return v4 ? v4.address : null;
}

/* A URL without its query or credentials, for logs and status. */
function redact(u) {
    try { const x = new URL(u); return x.protocol + '//' + x.host + x.pathname + (x.search ? '?…' : ''); } catch (e) { return '(invalid)'; }
}

/* ---- the cluster: QR code and video layer -------------------------------- */

const TOKEN = token();
const cr = new ClusterRender('vizualyse_cast');

/* Settings kept across restarts in STATE_DIR/settings.json: the service on
 * or off, and the QR code on the cluster (off by default: with navigation up
 * the cluster draws its direction list over it; the iDrive page shows it). */
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const settings = Object.assign({ enabled: true, clusterQr: false }, readJson(SETTINGS_FILE) || {});
function saveSettings() {
    try { mkdirp(STATE_DIR); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings) + '\n', { mode: 0o600 }); } catch (e) { log('settings: ' + e.message); }
}
let qrLayer = null, qrUrl = null, qrWanted = settings.clusterQr;

function link() { const ip = uplinkIp(); return ip ? 'http://' + ip + ':' + PORT + '/?t=' + TOKEN : null; }

/* RGBA pixels of the QR code of `text`, black on white with a 4-module quiet
 * zone, `px` pixels a module: { px, size }. */
function qrPixels(text, target) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), m = Math.max(2, Math.floor(target / (n + 8))), size = (n + 8) * m;
    const buf = Buffer.alloc(size * size * 4, 255);
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (!q.isDark(r, c)) continue;
            for (let y = (r + 4) * m; y < (r + 5) * m; y++) {
                const row = y * size * 4;
                for (let x = (c + 4) * m; x < (c + 5) * m; x++) buf.fill(0, row + x * 4, row + x * 4 + 3);
            }
        }
    }
    return { px: buf, size: size };
}

/* The QR code on the cluster's map area while idle and wanted. A content
 * layer: an overlay alone never takes the area from the cluster's own map. */
function updateQr() {
    /* Shown until the video's first frame: the area is never left empty in
     * between, which would hand it back to the cluster's own map. */
    const url = link(), show = settings.enabled && qrWanted && (!player || !player.frames) && !!url;
    if (url && url !== qrUrl) {
        if (qrLayer) cr.drop(qrLayer);
        const q = qrPixels(url, 300), W = 1088, H = 480;
        /* contend: take the centre from the stock map (cluster-render's
         * take-over), as the Waze map does; without it the layer waits for a
         * free slot, which in Map view never comes. */
        qrLayer = cr.image({ target: 'map', contend: true, x: Math.round((W - q.size) / 2), y: Math.round((H - q.size) / 2),
            w: q.size, h: q.size, iw: q.size, ih: q.size, visible: show });
        cr.pixels(qrLayer, null, q.px);
        qrUrl = url;
        log('qr: ' + url.replace(TOKEN, '<token>') + ' (' + q.size + ' px)');
    } else if (qrLayer) {
        cr.set(qrLayer, { visible: show });
    }
}

/* I420 to the renderer's 4:2:0 atlas: the Y plane, then each chroma row as
 * its U half followed by its V half. */
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

/* The largest rect of w:h inside the output's area (or band), centred. */
function placement(o) {
    const a = area(o);
    const s = Math.min(a.W / o.w, a.H / o.h), dw = Math.round(o.w * s), dh = Math.round(o.h * s);
    return { x: a.x + Math.round((a.W - dw) / 2), y: a.y + Math.round((a.H - dh) / 2), w: dw, h: dh };
}

/* The part of a target that is shown: its bands, or all of it. */
function area(o) {
    const x = o.xband ? Math.round(o.W * o.xband[0]) : 0, y = o.band ? Math.round(o.H * o.band[0]) : 0;
    return { x: x, y: y, W: o.xband ? Math.round(o.W * (o.xband[1] - o.xband[0])) : o.W,
        H: o.band ? Math.round(o.H * (o.band[1] - o.band[0])) : o.H };
}

/* ---- the proxy ----------------------------------------------------------- */

let proxy = null;
function startProxy() {
    proxy = spawn(process.execPath, [path.join(HERE, 'proxy.js'), String(PROXY_PORT)],
        { uid: INTERNET_UID, gid: INTERNET_UID, stdio: ['ignore', 'pipe', 'pipe'] });
    proxy.stdout.on('data', (d) => process.stdout.write(d));
    proxy.stderr.on('data', (d) => process.stderr.write(d));
    proxy.on('exit', (code, sig) => {
        log('proxy: exited (' + (sig || code) + ')');
        proxy = null;
        if (!stopping) setTimeout(startProxy, 2000);
    });
}

/* ---- playback ------------------------------------------------------------ */

let player = null;      /* { ff, py, opts, video, started, frames, lastErr[] } */
const consoleVideo = new consoleOut.ConsoleVideo(log);
let last = { state: 'idle' };
let lastPlay = null;    /* the last play's options (with its full URL): the app's Play last */
let lastCrop = null;    /* the last central-screen crop: the app's Mirror */

function o0(p) { return OUTPUTS[p.opts.output] || {}; }

function stopPlayer(why) {
    const p = player;
    if (!p) return;
    player = null;
    p.stopped = why;
    try { p.ff.kill('SIGTERM'); } catch (e) { /* gone */ }
    setTimeout(() => { try { p.ff.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
    if (p.py) try { p.py.kill('SIGTERM'); } catch (e) { /* gone */ }
    if (p.grab) try { p.grab.kill('SIGTERM'); } catch (e) { /* gone */ }
    if (p.video) cr.drop(p.video);
    if (o0(p).console) consoleVideo.stop();
    log('play: stopped (' + why + ') after ' + p.frames + ' frames');
    last = { state: 'idle', note: why, url: p.opts.shown, output: p.opts.output, frames: p.frames };
    updateQr();
}

function play(opts) {
    stopPlayer('replaced');
    lastPlay = opts;
    const screen = opts.source === 'screen';
    if (screen) lastCrop = opts.crop;
    let o = screen ? Object.assign({}, OUTPUTS[opts.output], MIRROR_SIZES[opts.output],
        MIRROR_BANDS[opts.output] ? { band: MIRROR_BANDS[opts.output] } : {}) : OUTPUTS[opts.output];
    const columns = screen && opts.crop.columns, ov = screen && opts.crop.overlay;
    let geo = null;
    if (columns) {
        const a = area(o);
        geo = layoutSize(columns, a.W, a.H, 0.8);
        o = Object.assign({}, o, { w: geo.w, h: geo.h });
    } else if (ov) {
        /* nearly the whole area at 8 fps: sharp, inside the upload ceiling */
        const a = area(o);
        geo = overlaySize(ov, a.W, a.H, 0.97);
        o = Object.assign({}, o, { w: geo.w, h: geo.h, fps: 8 });
    }
    if (o.w) o = Object.assign({}, o, { w: four(o.w), h: even(o.h) });
    const wantVideo = opts.output !== 'none';
    const isHttp = !screen && /^https?:/i.test(opts.url);
    const port = SCREEN_PORT + (screenSeq++ % SCREEN_PORTS);

    const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-threads', '3'];
    let crop = '';
    if (screen) {
        /* live: no -re, as little buffering as ffmpeg allows */
        const k = GRAB.w / SCREEN.W, c = opts.crop;
        crop = 'crop=' + even(c.w * k) + ':' + even(c.h * k) + ':' + even(c.x * k) + ':' + even(c.y * k) + ',';
        args.push('-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '500000', '-analyzeduration', '500000',
            '-f', 'mpegts', '-i', 'udp://127.0.0.1:' + port + '?overrun_nonfatal=1&fifo_size=65536');
    } else {
        if (opts.realtime) args.push('-re');
        if (isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        args.push('-i', opts.url);
    }
    if (wantVideo && ov) {
        args.push('-filter_complex', overlayGraph(geo, GRAB.w / SCREEN.W, o.fps, o.look), '-map', '[v]', '-f', 'rawvideo', 'pipe:1');
    } else if (wantVideo && columns) {
        args.push('-filter_complex', layoutGraph(columns, geo, GRAB.w / SCREEN.W, o.fps, o.look), '-map', '[v]', '-f', 'rawvideo', 'pipe:1');
    } else if (wantVideo) {
        args.push('-map', '0:v:0', '-vf', crop +
            'scale=' + o.w + ':' + o.h + ':force_original_aspect_ratio=decrease:flags=bilinear,' +
            'pad=' + o.w + ':' + o.h + ':-1:-1,fps=' + o.fps + (o.look ? ',' + o.look : '') + ',format=yuv420p',
            '-f', 'rawvideo', 'pipe:1');
    }
    if (opts.audio) {
        args.push('-map', '0:a:0', '-af', 'volume=' + (opts.volume / 100).toFixed(2), '-ac', '2', '-ar', '48000',
            '-f', 's16le', 'pipe:3');
    }

    const env = Object.assign({}, process.env, { http_proxy: 'http://127.0.0.1:' + PROXY_PORT, https_proxy: 'http://127.0.0.1:' + PROXY_PORT });
    const ff = spawn(FFMPEG, args, { env: env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const p = { ff: ff, py: null, opts: opts, video: null, started: Date.now(), frames: 0, lastErr: [] };
    player = p;
    log('play: ' + opts.shown + ' on ' + opts.output + (opts.audio ? ' with audio at ' + opts.volume + '%' : ' without audio'));
    if (screen) {
        /* the grabber after ffmpeg listens, so its first keyframe is not lost */
        setTimeout(() => {
            if (player !== p) return;
            const g = spawn(GRABBER, ['-s', 'center', '-g', GRAB.w + 'x' + GRAB.h, '-f', String(o.fps),
                '-p', 'h264_msdk(gop=' + o.fps + '), mpegts, udp', 'udp://127.0.0.1:' + port],
            { env: GRAB_ENV, stdio: ['ignore', 'ignore', 'pipe'] });
            p.grab = g;
            g.stderr.on('data', (d) => String(d).split('\n').filter((l) => l.trim()).forEach((l) => {
                p.lastErr.push('grabber: ' + l.trim());
                log('grabber: ' + l.trim());
            }));
            g.on('error', (e) => { p.lastErr.push('grabber: ' + e.message); try { ff.kill('SIGTERM'); } catch (x) { /* gone */ } });
            g.on('exit', (code, sig) => {
                if (player === p) { log('play: the grabber ended (' + (sig || code) + ')'); try { ff.kill('SIGTERM'); } catch (e) { /* gone */ } }
            });
        }, 400);
    }

    ff.stderr.on('data', (d) => {
        String(d).split('\n').filter((l) => l.trim()).forEach((l) => {
            p.lastErr.push(l.trim());
            if (p.lastErr.length > 6) p.lastErr.shift();
            log('ffmpeg: ' + l.trim());
        });
    });

    if (wantVideo) {
        const size = o.w * o.h * 3 / 2, out = Buffer.alloc(size);
        const r = o.console ? null : placement(o);
        if (o.console) consoleVideo.start(o.w, o.h, o.fps);
        /* prewarm: ask for the slot before the first frame (ffmpeg takes a
         * second or two to start); contend: take it from the stock content. */
        if (!o.console) p.video = cr.video({ target: o.target, z: 1, contend: true, prewarm: true, x: r.x, y: r.y, w: r.w, h: r.h, vw: o.w, vh: o.h, fps: o.fps });
        let parts = [], have = 0;
        ff.stdout.on('data', (d) => {
            parts.push(d);
            have += d.length;
            while (have >= size) {
                const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
                if (o.console) { consoleVideo.frame(all.slice(0, size)); ++p.frames; }
                else cr.frame(p.video, atlas(all.slice(0, size), o.w, o.h, out), ++p.frames);
                if (p.frames === 1) { log('play: first frame'); updateQr(); }
                parts = have > size ? [all.slice(size)] : [];
                have -= size;
            }
        });
    } else {
        ff.stdout.resume();
    }

    if (opts.audio) {
        const py = spawn(PYTHON, [path.join(HERE, 'pcm_play.py'), '--file', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        p.py = py;
        ff.stdio[3].pipe(py.stdin);
        py.stdin.on('error', () => { /* python gone: ffmpeg's write fails and it ends */ });
        py.stdout.on('data', (d) => log(String(d).trim()));
        py.stderr.on('data', (d) => { const l = String(d).trim(); p.lastErr.push(l); log(l); });
    } else {
        ff.stdio[3].resume();
    }

    updateQr();
    ff.on('exit', (code, sig) => {
        if (player !== p) return;     /* stopped or replaced */
        const ok = code === 0;
        log('play: ffmpeg ended (' + (sig || code) + ')');
        if (!ok && opts.audio && !p.frames && p.lastErr.some((l) => /matches no streams|does not contain any stream/i.test(l))) {
            log('play: the stream has no audio; again without it');
            return play(Object.assign({}, opts, { audio: false }));
        }
        player = null;
        if (p.grab) try { p.grab.kill('SIGTERM'); } catch (e) { /* gone */ }
        if (p.py) try { p.py.stdin.end(); } catch (e) { /* gone */ }
        if (p.video) cr.drop(p.video);
        if (o.console) consoleVideo.stop();
        last = { state: ok ? 'ended' : 'error', url: opts.shown, output: opts.output, frames: p.frames,
            error: ok ? null : (p.lastErr.slice(-3).join(' | ') || 'ffmpeg exited ' + (sig || code)) };
        updateQr();
    });
}

function status() {
    const up = readJson(UPLINK_STATUS) || {};
    const s = player
        ? { state: 'playing', url: player.opts.shown, output: player.opts.output, audio: player.opts.audio, volume: player.opts.volume,
            frames: player.frames, seconds: Math.round((Date.now() - player.started) / 1000) }
        : last;
    return Object.assign({ enabled: settings.enabled, uplink: up.state || 'unknown', render: cr.ready ? 'connected' : 'not connected', qr: qrWanted,
        link: link(), canReplay: !!lastPlay, screen: fs.existsSync(GRABBER),
        source: player ? player.opts.source || 'url' : (lastPlay && lastPlay.source) || 'url',
        crop: (player && player.opts.crop) || lastCrop || Object.assign({ preset: 'carplay' }, CROPS.carplay),
        crops: Object.keys(CROPS).map((k) => ({ id: k, title: CROPS[k].title, x: CROPS[k].x, y: CROPS[k].y, w: CROPS[k].w, h: CROPS[k].h,
            stack: CROPS[k].columns ? [].concat.apply([], CROPS[k].columns)
                : CROPS[k].overlay ? [CROPS[k].overlay.top, CROPS[k].overlay.base, CROPS[k].overlay.bottom] : null })),
        screenSize: SCREEN,
        outputs: Object.keys(OUTPUTS).filter((k) => k !== 'console' || consoleOut.available()).map((k) => ({ id: k, title: OUTPUTS[k].title })) }, s);
}

/* ---- the web page -------------------------------------------------------- */

const PAGE = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');

function send(res, code, type, body) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
}
function json(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }

function readBody(req, cb) {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 16384) req.destroy(); });
    req.on('end', () => { try { cb(null, b ? JSON.parse(b) : {}); } catch (e) { cb(e); } });
}

function authorised(req, u) {
    const t = req.headers['x-cast-token'] || u.searchParams.get('t') || '';
    return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!authorised(req, u)) return send(res, 403, 'text/plain', 'Scan the QR code on the iDrive Cast page to open this page.\n');
    if (!settings.enabled) return send(res, 503, 'text/plain', 'Cast to cluster is off: turn it on on the iDrive Cast page.\n');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, status());
    if (req.method === 'GET' && u.pathname === '/api/screen.jpg') {
        return snapshot((err, jpg) => (err ? json(res, 503, { error: 'no snapshot: ' + err.message }) : send(res, 200, 'image/jpeg', jpg)));
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

    readBody(req, (err, b) => {
        if (err) return json(res, 400, { error: 'bad JSON' });
        if (u.pathname === '/api/play' && b.source === 'screen') {
            const output = b.output === 'hud' ? 'hud' : 'map';
            const c = normCrop(b.crop);
            if (!c) return json(res, 400, { error: 'the crop must lie within the ' + SCREEN.W + 'x' + SCREEN.H + ' screen, at least 64x36' });
            if (!fs.existsSync(GRABBER)) return json(res, 400, { error: 'this head unit has no ' + GRABBER });
            play(mirrorOpts(c, output));
            return json(res, 200, status());
        }
        if (u.pathname === '/api/play') {
            let url;
            try { url = new URL(String(b.url || '')); } catch (e) { return json(res, 400, { error: 'not a URL' }); }
            if (!/^(https?|rtsp|rtmp):$/.test(url.protocol)) return json(res, 400, { error: 'http(s), rtsp or rtmp only' });
            const output = OUTPUTS[b.output] ? b.output : 'map';
            const audio = b.audio !== false;
            if (output === 'none' && !audio) return json(res, 400, { error: 'nothing to play: no video output and no audio' });
            const volume = Math.max(0, Math.min(150, Math.round(Number(b.volume) || 60)));
            play({ url: url.href, shown: redact(url.href), output: output, audio: audio, volume: volume, realtime: b.realtime !== false });
            return json(res, 200, status());
        }
        if (u.pathname === '/api/stop') { stopPlayer('stopped from the phone'); return json(res, 200, status()); }
        if (u.pathname === '/api/qr') { setQr(!!b.show); return json(res, 200, status()); }
        json(res, 404, { error: 'not found' });
    });
});

/* ---- start and stop ------------------------------------------------------ */

function mirrorOpts(crop, output) {
    return { source: 'screen', crop: crop, shown: 'Central screen (' + crop.title + ')', output: output, audio: false, volume: 0, realtime: false };
}

/* One JPEG of the central screen, for the page's crop preview; requests that
 * arrive while one is taken share it. */
let snapWaiters = null;
function snapshot(cb) {
    if (snapWaiters) { snapWaiters.push(cb); return; }
    snapWaiters = [cb];
    const f = '/tmp/vizualyse-cast-snap-' + process.pid + '.jpg';
    const done = (err, jpg) => { const w = snapWaiters; snapWaiters = null; w.forEach((fn) => fn(err, jpg)); };
    try { fs.unlinkSync(f); } catch (e) { /* none */ }
    const g = spawn(GRABBER, ['-s', 'center', '-n', '1', f], { env: GRAB_ENV, stdio: 'ignore' });
    const t = setTimeout(() => { try { g.kill('SIGKILL'); } catch (e) { /* gone */ } }, 6000);
    g.on('error', (e) => { clearTimeout(t); done(e); });
    g.on('exit', () => {
        clearTimeout(t);
        fs.readFile(f, (err, jpg) => { try { fs.unlinkSync(f); } catch (e) { /* none */ } done(err, jpg); });
    });
}

/* The iDrive app's commands over the control socket: null, or why not. */
function setQr(show) { qrWanted = show; settings.clusterQr = show; saveSettings(); updateQr(); }

/* On: the phone page reachable (its firewall rule), the QR code as set.
 * Off: nothing plays, no QR code, the page closed. */
function setEnabled(on) {
    settings.enabled = on;
    saveSettings();
    if (on) {
        try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); }
    } else {
        stopPlayer('turned off');
        try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); }
    }
    log('cast: ' + (on ? 'on' : 'off'));
    updateQr();
}

function command(c) {
    if (c.cmd === 'enable') { setEnabled(true); return null; }
    if (c.cmd === 'disable') { setEnabled(false); return null; }
    if (!settings.enabled) return 'Cast to cluster is off';
    if (c.cmd === 'mirror') {
        if (!fs.existsSync(GRABBER)) return 'this head unit has no screen grabber';
        const crop = c.crop ? normCrop(c.crop) : (lastCrop || Object.assign({ preset: 'carplay' }, CROPS.carplay));
        if (!crop) return 'unknown layout';
        play(mirrorOpts(crop, c.output === 'hud' ? 'hud' : 'map'));
        return null;
    }
    if (c.cmd === 'stop') { stopPlayer('stopped on the iDrive page'); return null; }
    if (c.cmd === 'qr') { setQr(!!c.show); return null; }
    if (c.cmd === 'replay') {
        if (!lastPlay) return 'nothing played yet: start a stream from the phone first';
        const output = OUTPUTS[c.output] ? c.output : lastPlay.output;
        if (output === 'console' && !consoleOut.available()) return 'the media console needs mgu-render';
        if (lastPlay.source === 'screen' && (output === 'console' || output === 'none')) return 'the central screen goes to the cluster map or the HUD';
        play(Object.assign({}, lastPlay, { output: output, audio: lastPlay.audio || output === 'none' }));
        return null;
    }
    return 'unknown command';
}

let control = null;
let stopping = false;
function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + ')');
    stopPlayer('shutting down');
    consoleVideo.stop();
    try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); }
    if (proxy) proxy.kill('SIGTERM');
    if (control) control.close();
    cr.close();
    web.close();
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

cr.on('ready', () => { log('render: connected (' + cr.backend + ')'); updateQr(); });
cr.on('disconnected', () => log('render: disconnected'));
cr.on('layer', (ref, state, reason) => log('render: layer ' + ref + (ref === qrLayer ? ' (qr)' : player && ref === player.video ? ' (video)' : '') +
    ' ' + state + (reason ? ': ' + reason : '')));
cr.on('target', (t, state, holder, reason) => log('render: target ' + t + ' ' + state + (holder && holder !== 'none' ? ' (holder ' + holder + ')' : '') + (reason ? ': ' + reason : '')));
cr.on('refused', (op, ref, reason) => log('render: refused ' + op + ' ' + ref + (reason ? ': ' + reason : '')));

if (settings.enabled) {
    try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); }
} else {
    log('cast: off (turn it on on the iDrive Cast page)');
}
startProxy();
web.listen(PORT, '0.0.0.0', () => log('web: listening on port ' + PORT));
control = startControl({ status: status, command: command, log: log });
cr.connect();
/* The address changes with the hotspot: keep the QR code current. */
setInterval(updateQr, 5000);
