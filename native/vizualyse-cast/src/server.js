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
const SCREEN_PORT = PORT + 2;
const SCREEN = { W: 1920, H: 720 };
const GRAB = { w: 960, h: 360, fps: 15 };
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
    gmaps: { x: 0, y: 0, w: 1920, h: 720, title: 'Google Maps (stacked)', columns: [[
        { x: 1112, y: 12, w: 650, h: 186 },
        { x: 230, y: 160, w: 650, h: 500 },
        { x: 1112, y: 580, w: 650, h: 128 },
    ]] },
    /* For the HUD's wide band: the banner over the readouts on the left, the
     * map (a wider, lower cut around the car) on the right. */
    gmapsHud: { x: 0, y: 0, w: 1920, h: 720, title: 'Google Maps (HUD)', columns: [[
        { x: 1112, y: 12, w: 650, h: 186 },
        { x: 1112, y: 580, w: 650, h: 128 },
    ], [
        { x: 180, y: 350, w: 750, h: 310 },
    ]] },
};

/* A layout's geometry fitted into W x H at `fill` of the room (the renderer
 * scales the layer up the rest of the way, keeping the upload small): the
 * frame { w, h } and each column's width and its regions' heights, all even.
 * Columns are first set to one height, each column's regions to one width. */
function layoutSize(columns, W, H, fill) {
    const nat = columns.map((col) => {
        const cw = Math.max.apply(null, col.map((r) => r.w));
        return { cw: cw, ch: col.reduce((n, r) => n + r.h * cw / r.w, 0) };
    });
    const hn = Math.max.apply(null, nat.map((c) => c.ch));
    const widths = nat.map((c) => c.cw * hn / c.ch), wn = widths.reduce((a, b) => a + b, 0);
    const k = Math.min(W * fill / wn, H * fill / hn), h = even(hn * k);
    const cols = columns.map((col, j) => {
        const w = even(widths[j] * k), sum = col.reduce((n, r) => n + r.h * w / r.w, 0);
        return { w: w, heights: col.map((r) => even(r.h * w / r.w * h / sum)) };
    });
    return { w: cols.reduce((n, c) => n + c.w, 0), h: h, cols: cols };
}

/* The filter graph of a layout: each region cropped from the half-size grab
 * (k: grab pixels a screen pixel) and scaled into its place, each column
 * stacked, the columns side by side, at the frame's exact size. */
function layoutGraph(columns, geo, k, fps) {
    const parts = [], all = [];
    columns.forEach((col, j) => col.forEach((r, i) => all.push({ r: r, j: j, i: i })));
    parts.push('[0:v]split=' + all.length + all.map((a, n) => '[i' + n + ']').join(''));
    all.forEach((a, n) => {
        const r = a.r;
        parts.push('[i' + n + ']crop=' + even(r.w * k) + ':' + even(r.h * k) + ':' + even(r.x * k) + ':' + even(r.y * k) +
            ',scale=' + geo.cols[a.j].w + ':' + geo.cols[a.j].heights[a.i] + ':flags=bicubic[r' + a.j + '_' + a.i + ']');
    });
    columns.forEach((col, j) => {
        const ins = col.map((r, i) => '[r' + j + '_' + i + ']').join('');
        parts.push(ins + (col.length > 1 ? 'vstack=inputs=' + col.length + ',' : '') + 'scale=' + geo.cols[j].w + ':' + geo.h + '[c' + j + ']');
    });
    const cols = columns.map((c, j) => '[c' + j + ']').join('');
    parts.push(cols + (columns.length > 1 ? 'hstack=inputs=' + columns.length + ',' : '') +
        'scale=' + geo.w + ':' + geo.h + ',fps=' + fps + ',format=yuv420p[v]');
    return parts.join(';');
}

/* The mirror's frame sizes: the cluster map at its own 2.27:1, the HUD as before. */
const MIRROR_SIZES = { map: { w: 544, h: 240 }, hud: { w: 480, h: 270 } };
const GRAB_ENV = Object.assign({}, process.env, { XDG_RUNTIME_DIR: '/run/wayland' });

function even(n) { return Math.max(0, Math.round(n / 2) * 2); }

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
    hud: { target: 'hud', W: 800, H: 480, w: 480, h: 270, fps: 15, band: [0.25, 0.65], title: 'HUD' },
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
    const top = o.band ? Math.round(o.H * o.band[0]) : 0;
    const areaH = o.band ? Math.round(o.H * (o.band[1] - o.band[0])) : o.H;
    const s = Math.min(o.W / o.w, areaH / o.h), dw = Math.round(o.w * s), dh = Math.round(o.h * s);
    return { x: Math.round((o.W - dw) / 2), y: top + Math.round((areaH - dh) / 2), w: dw, h: dh };
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
    let o = screen ? Object.assign({}, OUTPUTS[opts.output], MIRROR_SIZES[opts.output]) : OUTPUTS[opts.output];
    const columns = screen && opts.crop.columns;
    let geo = null;
    if (columns) {
        const area = o.band ? { W: o.W, H: Math.round(o.H * (o.band[1] - o.band[0])) } : { W: o.W, H: o.H };
        geo = layoutSize(columns, area.W, area.H, 0.8);
        o = Object.assign({}, o, { w: geo.w, h: geo.h });
    }
    const wantVideo = opts.output !== 'none';
    const isHttp = !screen && /^https?:/i.test(opts.url);

    const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-threads', '3'];
    let crop = '';
    if (screen) {
        /* live: no -re, as little buffering as ffmpeg allows */
        const k = GRAB.w / SCREEN.W, c = opts.crop;
        crop = 'crop=' + even(c.w * k) + ':' + even(c.h * k) + ':' + even(c.x * k) + ':' + even(c.y * k) + ',';
        args.push('-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '500000', '-analyzeduration', '500000',
            '-f', 'mpegts', '-i', 'udp://127.0.0.1:' + SCREEN_PORT + '?overrun_nonfatal=1&fifo_size=65536');
    } else {
        if (opts.realtime) args.push('-re');
        if (isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        args.push('-i', opts.url);
    }
    if (wantVideo && columns) {
        args.push('-filter_complex', layoutGraph(columns, geo, GRAB.w / SCREEN.W, o.fps), '-map', '[v]', '-f', 'rawvideo', 'pipe:1');
    } else if (wantVideo) {
        args.push('-map', '0:v:0', '-vf', crop +
            'scale=' + o.w + ':' + o.h + ':force_original_aspect_ratio=decrease:flags=bilinear,' +
            'pad=' + o.w + ':' + o.h + ':-1:-1,fps=' + o.fps + ',format=yuv420p',
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
            const g = spawn(GRABBER, ['-s', 'center', '-g', GRAB.w + 'x' + GRAB.h, '-f', String(GRAB.fps),
                '-p', 'h264_msdk(gop=' + GRAB.fps + '), mpegts, udp', 'udp://127.0.0.1:' + SCREEN_PORT],
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
            stack: CROPS[k].columns ? [].concat.apply([], CROPS[k].columns) : null })),
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
