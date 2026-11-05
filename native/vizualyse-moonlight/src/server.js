// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse-moonlight: a Moonlight client for the iDrive 7 head unit. Games
 * streamed from a PC running Sunshine (GameStream) to the central screen,
 * with their sound through the car's speakers and game controllers, while
 * parked. Controlled from a phone page; the iDrive app (vizualyse_moonlight)
 * shows its link.
 *
 * - A web page on the uplink's Wi-Fi address (the phone's hotspot), port
 *   8490, behind a token: add a PC, pair it (a PIN to type on Sunshine's
 *   page), pick a game, stream settings, an on-screen pad.
 * - gamestream.js: serverinfo, pairing, the app list, launch and quit.
 * - moonlight-core (C, moonlight-common-c): the stream; H.264 on its stdout,
 *   decoded audio on fd 3, the controllers (evdev) itself.
 * - ffmpeg (static, the same build as Cast's) decodes the H.264 to I420, at
 *   the stream's size for the central screen (console_out.js, mgu-render,
 *   black bars at the sides) or scaled down for the cluster or the HUD
 *   (cluster-render, within its upload budget).
 * - The picture on the central screen covers the iDrive's own controls, so
 *   it stops from there too: hold the screen 2 s (moonlight-core reads the
 *   display's touch passively, core/touch.h; nothing is claimed or
 *   diverted), or hold Start + Back + LB + RB 2 s on a controller, or Stop on
 *   the phone page. For the first 10 s ffmpeg burns in a line saying so.
 * - pcm_play.py (mgu-python) plays the audio into SmartXbar.
 *
 *   node server.js     (root: /dev/input, the renderer, ALSA, nftables)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { URL } = require('url');
const firewall = require('./firewall.js');
const consoleOut = require('./console_out.js');
const { startControl } = require('./control.js');
const { fork } = require('child_process');
const { ClusterRender } = require('./cluster_render_client.js');

const HERE = __dirname;
const STATE_DIR = process.env.MOONLIGHT_STATE || '/var/opt/vizualyse-moonlight/state';
const PORT = Number(process.env.MOONLIGHT_PORT) || 8490;
const IFNAME = 'wlan0';
const CORE = process.env.MOONLIGHT_CORE || path.join(HERE, 'moonlight-core');
const FFMPEG = process.env.MOONLIGHT_FFMPEG || path.join(HERE, 'ffmpeg');
const PYTHON = process.env.MOONLIGHT_PYTHON || '/var/opt/mgu-python/current/bin/python3';
const LEASE = '/run/mgu-uplink/lease.json';
const UPLINK_STATUS = '/run/mgu-uplink/status.json';
const NO_FIREWALL = process.env.MOONLIGHT_NO_FIREWALL === '1';
/* The tool's uplink uid (component.json "uids"): mgu-uplink routes only the
 * listed uids through wlan0, and root has no route to the PC there. The
 * GameStream requests (gs_worker.js) and moonlight-core's stream run as it. */
const NET_UID = Number(process.env.MOONLIGHT_NET_UID) || 12998;
/* Where the centre display's touch arrives (the car: vlan73, from the display
 * 160.48.199.115); MOONLIGHT_TOUCH_IFACE= turns it off, MOONLIGHT_TOUCH_FILE
 * replays a capture instead (the tests). */
const TOUCH_IFACE = process.env.MOONLIGHT_TOUCH_IFACE !== undefined ? process.env.MOONLIGHT_TOUCH_IFACE : 'vlan73';
const TOUCH_SRC = process.env.MOONLIGHT_TOUCH_SRC || '160.48.199.115';
const TOUCH_FILE = process.env.MOONLIGHT_TOUCH_FILE || '';
const FONT = path.join(HERE, 'DejaVuSans-Bold.ttf');
const HINT_SECONDS = 10;
const HINT_TEXT = 'To stop: hold the screen for 2 s  ·  or hold Start + Back + LB + RB  ·  or Stop on the phone';

/* What the phone page offers. The Atom decodes in software: 720p is the
 * default; 60 fps is the one to try on the car. */
const MODES = [
    { id: '1280x720', w: 1280, h: 720 }, { id: '960x540', w: 960, h: 540 }, { id: '1920x1080', w: 1920, h: 1080 },
];
const RATES = [30, 60];

/* Where the picture goes. The cluster and the HUD go through cluster-render,
 * which uploads at most ~5500 KB/s: a smaller frame at 15 fps, scaled up by
 * the renderer (Learnings, "The cluster and the HUD"). */
const OUTPUTS = {
    console: { title: 'Centre console', console: true },
    map: { title: 'Cluster', target: 'map', W: 1088, H: 480, w: 640, h: 360, fps: 15 },
    /* band: the part of the HUD's height clear of its clipped top and the
     * speed; xband: the part of its width the optics show */
    hud: { title: 'HUD', target: 'hud', W: 800, H: 480, w: 480, h: 270, fps: 15, band: [0.25, 0.65], xband: [0.17, 0.83] },
};

const log = (s) => console.log(new Date().toISOString() + ' ' + s);

/* ---- small helpers ------------------------------------------------------- */

function mkdirp(d) { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d, 0o700); } }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(f, obj) { mkdirp(path.dirname(f)); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(f + '.tmp', f); }

/* The token in the QR link: kept across restarts, so a saved link works. */
function token() {
    const f = path.join(STATE_DIR, 'token');
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{16}$/.test(t)) return t; } catch (e) { /* new */ }
    const t = crypto.randomBytes(8).toString('hex');
    mkdirp(STATE_DIR);
    fs.writeFileSync(f, t + '\n', { mode: 0o600 });
    return t;
}

/* The client's identity: moonlight-core's certificate and key, a unique id. */
function identity() {
    const dir = path.join(STATE_DIR, 'identity');
    const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem'), uid = path.join(dir, 'uniqueid');
    mkdirp(dir);
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
        log('identity: a new client certificate');
        execFileSync(CORE, ['gencert', cert, key], { timeout: 60000 });
    }
    if (!fs.existsSync(uid)) fs.writeFileSync(uid, crypto.randomBytes(8).toString('hex').toUpperCase() + '\n', { mode: 0o600 });
    return { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8'), uniqueId: fs.readFileSync(uid, 'utf8').trim() };
}

function uplinkIp() {
    const l = readJson(LEASE);
    if (l && l.ip) return l.ip;
    const ifs = os.networkInterfaces()[IFNAME] || [];
    const v4 = ifs.filter((a) => a.family === 'IPv4' && !a.internal)[0];
    return v4 ? v4.address : (process.env.MOONLIGHT_LINK_IP || null);
}

const TOKEN = token();
let ID = null;
function link() { const ip = uplinkIp(); return ip ? 'http://' + ip + ':' + PORT + '/?t=' + TOKEN : null; }

/* ---- settings and hosts --------------------------------------------------- */

const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const HOSTS_FILE = path.join(STATE_DIR, 'hosts.json');
const settings = Object.assign({ enabled: true, output: 'console', mode: '1280x720', fps: 30, bitrate: 8000, audio: true, volume: 100, sops: true,
    localAudio: false, last: null }, readJson(SETTINGS_FILE) || {});
function saveSettings() { try { writeJson(SETTINGS_FILE, settings); } catch (e) { log('settings: ' + e.message); } }

/* [{ id, name, address, httpsPort, serverCert, paired, appversion, ... }] */
let hosts = readJson(HOSTS_FILE) || [];
function saveHosts() { try { writeJson(HOSTS_FILE, hosts); } catch (e) { log('hosts: ' + e.message); } }
function hostById(id) { return hosts.filter((h) => h.id === id)[0] || null; }
/* GameStream through the worker, as NET_UID: the same methods as
 * gamestream.js's GameStream, each a promise; the host's httpsPort and
 * serverCert come back into h. */
let worker = null, workerSeq = 0;
const pending = new Map();
function startWorker() {
    const w = fork(path.join(HERE, 'gs_worker.js'), [], { uid: NET_UID, gid: NET_UID, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    w.on('message', (m) => {
        if (m.log) return log('gamestream: ' + m.log);
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.host) { if (m.host.httpsPort) p.h.httpsPort = m.host.httpsPort; }
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    w.on('exit', (code, sig) => {
        log('gamestream: worker ended (' + (sig || code) + ')');
        if (worker === w) worker = null;
        pending.forEach((p) => p.reject(new Error('the network worker ended')));
        pending.clear();
    });
    w.on('error', (e) => log('gamestream: worker: ' + e.message));
    return w;
}
function call(h, op, args, timeout) {
    if (!ID) return Promise.reject(new Error('no client certificate (see the log)'));
    if (!worker) worker = startWorker();
    const id = ++workerSeq;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { if (pending.delete(id)) reject(new Error('no answer from the network worker')); }, timeout || 30000);
        pending.set(id, { h: h, resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
        worker.send({ id: id, op: op, ident: ID, args: args,
            host: { address: h.address, httpPort: h.httpPort, httpsPort: h.httpsPort, serverCert: h.serverCert } });
    });
}
function client(h) {
    return {
        serverInfo: () => call(h, 'serverInfo', []),
        pair: (pin, wait) => call(h, 'pair', [pin, wait], (wait || 120000) + 30000),
        appList: () => call(h, 'appList', []),
        launch: (appId, cfg) => call(h, 'launch', [appId, cfg], 60000),
        quit: () => call(h, 'quit', [], 30000),
    };
}
/* What the page sees of a host: never its certificate. */
function hostView(h) {
    return { id: h.id, name: h.name, address: h.address, paired: !!h.paired, online: h.online !== false,
        busy: !!h.currentGame, currentGame: h.currentGame || 0, error: h.error || null, apps: h.apps || null };
}

function refreshHost(h) {
    return client(h).serverInfo().then((i) => {
        h.name = i.name; h.appversion = i.appversion; h.gfeversion = i.gfeversion; h.codecs = i.codecs;
        h.httpsPort = i.httpsPort; h.mac = i.mac; h.currentGame = i.currentGame; h.online = true; h.error = null;
        if (h.serverCert && !i.paired) { h.paired = false; h.error = 'the PC no longer knows this car: pair again'; }
        else h.paired = !!h.serverCert && i.paired;
        return h;
    }, (e) => { h.online = false; h.error = e.message; return h; });
}

function addHost(address) {
    const a = String(address || '').trim();
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(a)) return Promise.reject(new Error('an IP address or host name'));
    const h = { address: a, id: null, name: a };
    return client(h).serverInfo().then((i) => {
        const id = i.uniqueId || a;
        let known = hostById(id);
        if (!known) { known = { id: id, address: a }; hosts.push(known); }
        known.address = a;
        return refreshHost(known).then(() => { saveHosts(); log('hosts: ' + known.name + ' at ' + a + (known.paired ? ', paired' : '')); return known; });
    });
}

/* Pairing: one at a time. { hostId, pin, state: 'waiting'|'paired'|'failed', error } */
let pairing = null;
function startPairing(h) {
    if (pairing && pairing.state === 'waiting') return Promise.reject(new Error('a pairing is already waiting for its PIN'));
    const pin = String(1000 + crypto.randomBytes(2).readUInt16BE(0) % 9000);
    pairing = { hostId: h.id, name: h.name, pin: pin, state: 'waiting', error: null, started: Date.now() };
    const p = pairing;
    h.serverCert = undefined; h.paired = false;
    log('pair: ' + h.name + ', waiting for the PIN to be typed on the PC');
    client(h).pair(pin, 180000).then((cert) => {
        h.serverCert = cert; h.paired = true; h.error = null;
        saveHosts();
        p.state = 'paired';
        log('pair: ' + h.name + ' paired');
        return client(h).appList().then((a) => { h.apps = a; }, () => null);
    }, (e) => {
        p.state = 'failed'; p.error = e.message;
        log('pair: ' + h.name + ': ' + e.message);
    });
    return Promise.resolve(p);
}

/* ---- the stream ------------------------------------------------------------ */

let session = null;   /* { host, app, core, ff, py, frames, fps, started, events, stopping } */
let last = { state: 'idle' };
let pads = [];        /* found while idle: moonlight-core pads */
const consoleVideo = new consoleOut.ConsoleVideo(log);
const cr = new ClusterRender('vizualyse_moonlight');

/* I420 to cluster-render's 4:2:0 atlas: the Y plane, then each chroma row as
 * its U half followed by its V half (as Cast). */
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
/* The largest rect of w:h inside the output's shown part, centred. */
function placement(o) {
    const ax = o.xband ? Math.round(o.W * o.xband[0]) : 0, ay = o.band ? Math.round(o.H * o.band[0]) : 0;
    const aw = o.xband ? Math.round(o.W * (o.xband[1] - o.xband[0])) : o.W, ah = o.band ? Math.round(o.H * (o.band[1] - o.band[0])) : o.H;
    const k = Math.min(aw / o.w, ah / o.h), dw = Math.round(o.w * k), dh = Math.round(o.h * k);
    return { x: ax + Math.round((aw - dw) / 2), y: ay + Math.round((ah - dh) / 2), w: dw, h: dh };
}
/* The stop hint for the centre console: an ASS subtitle at the stream's size,
 * shown for HINT_SECONDS, and libass's fonts folder (the font alone in it:
 * libass tries every file in that folder). ffmpeg -vf arguments, or [] when
 * the font is missing. */
function hintFilter(w, h) {
    try {
        const dir = path.join(STATE_DIR, 'fonts');
        mkdirp(dir);
        const font = path.join(dir, path.basename(FONT));
        if (!fs.existsSync(font) || fs.statSync(font).size !== fs.statSync(FONT).size) fs.copyFileSync(FONT, font);
        const size = Math.max(16, Math.round(h / 26)), margin = Math.round(h / 18);
        const ass = path.join(STATE_DIR, 'hint.ass');
        const end = '0:00:' + (HINT_SECONDS < 10 ? '0' : '') + HINT_SECONDS + '.00';
        fs.writeFileSync(ass, ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + w, 'PlayResY: ' + h, 'WrapStyle: 2', '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            /* white on a half-transparent black box, bottom centre */
            'Style: Hint,DejaVu Sans,' + size + ',&H00FFFFFF,&H00FFFFFF,&H60000000,&H60000000,-1,0,0,0,100,100,0,0,3,' + Math.round(size / 3) + ',0,2,' + margin + ',' + margin + ',' + margin + ',1', '',
            '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
            'Dialogue: 0,0:00:00.00,' + end + ',Hint,,0,0,0,,' + HINT_TEXT, ''].join('\n'));
        return ['-vf', 'subtitles=filename=' + ass + ':fontsdir=' + dir];
    } catch (e) {
        log('stream: no stop hint: ' + e.message);
        return [];
    }
}

function outputReady(id) {
    const o = OUTPUTS[id];
    if (!o) return false;
    return o.console ? consoleOut.available() : cr.ready;
}

const STAGE_HELP = {
    'RTSP handshake': 'the PC refused the stream (is Sunshine running, and the game started?)',
    'control stream establishment': 'no control connection to the PC',
    'video stream establishment': 'no video from the PC',
    'audio stream establishment': 'no audio from the PC',
};
function termText(e) {
    if (e.code === 0) return null;
    if (e.code === -100) return 'no video arrived: UDP ' + (e.ports || '47998') + ' blocked between the car and the PC?';
    if (e.code === -101) return 'the stream stopped sending frames';
    if (e.code === -102) return 'the PC ended the stream right after it started';
    return 'the connection to the PC was lost (' + e.code + (e.ports ? ', ports ' + e.ports : '') + ')';
}

function setVolume(buf, vol) {
    if (vol === 100) return buf;
    const g = vol / 100;
    for (let i = 0; i + 1 < buf.length; i += 2) {
        let v = Math.round(buf.readInt16LE(i) * g);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        buf.writeInt16LE(v, i);
    }
    return buf;
}

function stopSession(why, then) {
    const s = session;
    if (!s) { if (then) then(); return; }
    session = null;
    s.stopping = why;
    log('stream: stopping (' + why + ') after ' + s.frames + ' frames');
    try { s.core.stdin.write('quit\n'); } catch (e) { /* gone */ }
    const kill = setTimeout(() => { try { s.core.kill('SIGKILL'); } catch (e) { /* gone */ } }, 4000);
    s.core.once('exit', () => {
        clearTimeout(kill);
        if (then) then();
    });
    last = { state: 'ended', host: s.host, app: s.app, frames: s.frames, note: why, error: s.error || null };
}

/* After the core: ffmpeg and the audio player go, the picture comes down. */
function teardown(s) {
    try { s.ff.stdin.end(); } catch (e) { /* gone */ }
    setTimeout(() => { try { s.ff.kill('SIGKILL'); } catch (e) { /* gone */ } }, 2000);
    /* killed, not drained: what it still holds would play after Stop (SmartXbar can take a long
     * time to connect at first, so seconds of buffered sound came out minutes later on the car) */
    if (s.py) {
        /* SIGTERM, then SIGKILL: pcm_play.py can sit in a blocking ALSA write (while SmartXbar connects) where
         * Python never runs its SIGTERM handler; it kept playing after Stop on the car */
        const py = s.py;
        try { py.kill('SIGTERM'); } catch (e) { /* gone */ }
        setTimeout(() => { try { py.kill('SIGKILL'); } catch (e) { /* gone */ } }, 500);
    }
    if (s.out.console) consoleVideo.stop();
    else if (s.layer) cr.drop(s.layer);
    if (!NO_FIREWALL) { try { firewall.host(null); } catch (e) { log('firewall: ' + e.message); } }
}

function startStream(h, app, launch, retried) {
    const mode = MODES.filter((m) => m.id === settings.mode)[0] || MODES[0];
    const fps = settings.fps, w = mode.w, hgt = mode.h;
    if (!NO_FIREWALL) { try { firewall.host(h.address); } catch (e) { log('firewall: ' + e.message); } }
    const args = ['stream', '--address', h.address, '--appversion', h.appversion || '7.1.431.-1', '--gfeversion', h.gfeversion || '',
        '--rtsp', launch.rtsp || '', '--codecs', String(h.codecs || 1), '--width', String(w), '--height', String(hgt),
        '--fps', String(fps), '--bitrate', String(settings.bitrate), '--rikey', launch.rikey, '--rikeyid', String(launch.rikeyid),
        '--uid', String(NET_UID), '--gid', String(NET_UID)];
    /* hold-to-stop, while the picture covers the centre screen */
    if ((OUTPUTS[settings.output] || OUTPUTS.console).console) {
        if (TOUCH_FILE) args.push('--touch-file', TOUCH_FILE);
        else if (TOUCH_IFACE) args.push('--touch-iface', TOUCH_IFACE, '--touch-src', TOUCH_SRC);
    }
    const core = spawn(CORE, args, { stdio: ['pipe', 'pipe', 'pipe', settings.audio ? 'pipe' : 'ignore'] });
    /* low delay: a small probe (Learnings: -fflags nobuffer gave no frames
     * through a filter), slice threads (the core asks the PC for 4 slices) */
    const out = OUTPUTS[settings.output] || OUTPUTS.console;
    /* the console takes the stream's own size; the cluster and the HUD a
     * smaller frame at their rate (an fps filter is fine without -fflags
     * nobuffer, Learnings) */
    const fw = out.console ? w : out.w, fh = out.console ? hgt : out.h, ffps = out.console ? fps : out.fps;
    /* the console: the stop hint for its first seconds; -framerate gives the
     * raw H.264 its clock, which the subtitle is timed by */
    const vf = out.console ? hintFilter(w, hgt) : ['-vf', 'fps=' + out.fps + ',scale=' + fw + ':' + fh + ':force_original_aspect_ratio=decrease:flags=bilinear,pad=' + fw + ':' + fh + ':-1:-1'];
    const ff = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-flags', 'low_delay', '-thread_type', 'slice', '-threads', '4',
        '-probesize', '32768', '-analyzeduration', '0', '-f', 'h264', '-framerate', String(fps), '-i', 'pipe:0'].concat(vf, ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']),
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const s = { host: { id: h.id, name: h.name, address: h.address }, app: { id: app.id, name: app.name }, core: core, ff: ff, py: null,
        frames: 0, fps: 0, rtt: 0, poor: false, started: Date.now(), connected: false, error: null, pads: {}, w: w, h: hgt, fpsWanted: fps,
        out: out, output: OUTPUTS[settings.output] ? settings.output : 'console', layer: null };
    session = s;
    log('stream: ' + app.name + ' from ' + h.name + ' at ' + w + 'x' + hgt + '@' + fps + ', ' + settings.bitrate + ' kbps' + (settings.audio ? ', sound ' + settings.volume + '%' : ', no sound') +
        ', on the ' + out.title + (out.console ? '' : ' (' + fw + 'x' + fh + '@' + ffps + ')'));

    core.on('error', (e) => { s.error = 'moonlight-core: ' + e.message; });
    ff.on('error', (e) => { s.error = 'ffmpeg: ' + e.message; });
    core.stdout.pipe(ff.stdin);
    ff.stdin.on('error', () => { /* ffmpeg gone: the core's write fails and it stops */ });
    ff.stderr.on('data', (d) => String(d).split('\n').filter((l) => l.trim()).forEach((l) => log('ffmpeg: ' + l.trim())));

    const size = fw * fh * 3 / 2, packed = out.console ? null : Buffer.alloc(size);
    if (out.console) consoleVideo.start(w, hgt, fps);
    else {
        const r = placement(out);
        /* prewarm: the slot before the first frame; contend: from the stock content (as Cast) */
        s.layer = cr.video({ target: out.target, z: 1, contend: true, prewarm: true, x: r.x, y: r.y, w: r.w, h: r.h, vw: fw, vh: fh, fps: ffps });
    }
    let parts = [], have = 0;
    ff.stdout.on('data', (d) => {
        parts.push(d); have += d.length;
        while (have >= size) {
            const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
            if (out.console) consoleVideo.frame(all.slice(0, size));
            else cr.frame(s.layer, atlas(all.slice(0, size), fw, fh, packed), s.frames + 1);
            if (++s.frames === 1) log('stream: first frame');
            parts = have > size ? [all.slice(size)] : [];
            have -= size;
        }
    });

    if (settings.audio) {
        /* --live: it never falls behind (SmartXbar's first connect can block for many seconds) */
        const py = spawn(PYTHON, [path.join(HERE, 'pcm_play.py'), '--file', '-', '--live'], { stdio: ['pipe', 'pipe', 'pipe'] });
        s.py = py;
        py.on('error', (e) => log('audio: ' + e.message));
        py.stdin.on('error', () => { /* python gone */ });
        py.stdout.on('data', (d) => log(String(d).trim()));
        py.stderr.on('data', (d) => log(String(d).trim()));
        const vol = settings.volume;
        core.stdio[3].on('data', (d) => {
            /* the player reads all it is given at once; while it can't (blocked opening SmartXbar), don't
             * keep more than 1 s here either: it would only be dropped there */
            const ws = py.stdin._writableState;
            if (ws && ws.length > 48000 * 4) return;
            try { py.stdin.write(setVolume(d, vol)); } catch (e) { /* gone */ }
        });
    }

    let buf = '';
    core.stderr.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i); buf = buf.slice(i + 1);
            if (l[0] !== '@') { if (l.trim()) log('core: ' + l.trim()); continue; }
            let e;
            try { e = JSON.parse(l.slice(1)); } catch (x) { log('core: ' + l); continue; }
            if (e.ev === 'stats') { s.fps = e.fps; s.rtt = e.rtt; continue; }
            if (e.ev === 'status') { s.poor = e.poor; continue; }
            if (e.ev === 'rumble') continue;
            if (e.ev === 'exit-hold') { log('stream: the screen held at ' + e.x + ',' + e.y); stopSession('the screen was held'); continue; }
            if (e.ev === 'exit-combo') { log('stream: the quit combo on controller ' + e.slot); stopSession('Start + Back + LB + RB held'); continue; }
            log('core: ' + JSON.stringify(e));
            if (e.ev === 'started') s.connected = true;
            else if (e.ev === 'pad') { if (e.present) s.pads[e.slot] = e.name; else delete s.pads[e.slot]; }
            else if (e.ev === 'stage-failed') {
                s.rtspFailed = e.stage === 'RTSP handshake';
                s.error = 'could not start the ' + e.stage + ': ' + (STAGE_HELP[e.stage] || 'error ' + e.code) + (e.ports ? ' (ports ' + e.ports + ')' : '');
            }
            else if (e.ev === 'terminated') s.error = termText(e);
            else if (e.ev === 'failed' && !s.error) s.error = 'the stream did not start (' + e.code + ')';
        }
    });

    core.on('exit', (code, sig) => {
        log('stream: moonlight-core ended (' + (sig || code) + ')');
        teardown(s);
        /* Sunshine can hold an earlier launch nobody connected to and match
         * this RTSP to it (its key then fails: "Failed to verify RTSP message
         * tag"); that consumes it, so one more launch works. */
        if (session === s && s.rtspFailed && !s.frames && !retried && !stopping && settings.enabled) {
            session = null;
            log('stream: the RTSP handshake failed; launching once more');
            refreshHost(h).then(() => play(h.id, app.id, true)).catch((e) => {
                last = { state: 'error', host: s.host, app: s.app, frames: 0, error: e.message };
            });
            return;
        }
        if (session === s) {
            session = null;
            last = { state: s.error ? 'error' : 'ended', host: s.host, app: s.app, frames: s.frames, error: s.error,
                note: s.error ? null : 'the stream ended; the game keeps running on the PC' };
        }
        refreshHost(h).then(() => saveHosts());
    });
}

/* Launch (or resume) app on host, then stream it. */
function play(hostId, appId, retried) {
    const h = hostById(hostId);
    if (!h) return Promise.reject(new Error('no such PC'));
    if (!h.paired) return Promise.reject(new Error(h.name + ' is not paired: pair it first'));
    return refreshHost(h).then(() => {
        if (h.online === false) throw new Error(h.name + ' is not reachable: ' + h.error);
        if (!h.paired) throw new Error(h.error || h.name + ' is not paired');
        const apps = h.apps || [];
        const app = apps.filter((a) => a.id === Number(appId))[0] || (appId ? { id: Number(appId), name: 'App ' + appId } : null);
        if (!app) throw new Error('pick a game');
        const resume = h.currentGame === app.id;
        if (h.currentGame && !resume) throw new Error(h.name + ' is running another game: quit it first');
        const mode = MODES.filter((m) => m.id === settings.mode)[0] || MODES[0];
        return new Promise((resolve) => stopSession('replaced', resolve)).then(() => {
            last = { state: 'starting', host: { id: h.id, name: h.name, address: h.address }, app: app };
            return client(h).launch(app.id, { width: mode.w, height: mode.h, fps: settings.fps, sops: settings.sops,
                localAudio: settings.localAudio, gamepadMask: 0xf, resume: resume });
        }).then((launch) => {
            settings.last = { hostId: h.id, host: h.name, appId: app.id, app: app.name };
            saveSettings();
            startStream(h, app, launch, retried);
        }, (e) => {
            last = { state: 'error', host: { id: h.id, name: h.name, address: h.address }, app: app, error: e.message };
            throw e;
        });
    });
}

function quitGame() {
    const s = session, hid = (s && s.host.id) || (last.host && last.host.id) || (settings.last && settings.last.hostId);
    const h = hid && hostById(hid);
    if (!h) return Promise.reject(new Error('no PC to quit a game on'));
    return new Promise((resolve) => stopSession('quit', resolve))
        .then(() => client(h).quit())
        .then(() => { last = Object.assign({}, last, { state: 'ended', note: 'the game was closed on ' + h.name }); return refreshHost(h); })
        .then(() => saveHosts());
}

/* The game controllers, while nothing streams (the core reports them while it does). */
function scanPads() {
    if (session) return;
    execFile(CORE, ['pads'], { timeout: 5000 }, (err, out) => {
        if (err) return;
        pads = String(out).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    });
}

/* ---- status ---------------------------------------------------------------- */

function state() {
    if (session) return session.frames ? 'streaming' : 'starting';
    return last.state || 'idle';
}

function status() {
    const up = readJson(UPLINK_STATUS) || {};
    const s = session;
    const padList = s ? Object.keys(s.pads).map((k) => ({ slot: Number(k), name: s.pads[k] })) : pads.map((p, i) => ({ slot: i, name: p.name }));
    const cur = s || last;
    return {
        enabled: settings.enabled, link: link(), uplink: up.state || 'unknown', render: (consoleOut.available() ? 'mgu-render' : 'no mgu-render') + ', ' + (cr.ready ? 'cluster-render' : 'no cluster-render'),
        state: state(), host: cur.host ? { name: cur.host.name, address: cur.host.address } : null,
        app: cur.app ? { id: cur.app.id, name: cur.app.name } : null,
        frames: s ? s.frames : (last.frames || 0), fps: s ? s.fps : 0, rtt: s ? s.rtt : 0, poor: s ? s.poor : false,
        seconds: s ? Math.round((Date.now() - s.started) / 1000) : 0, size: s ? s.w + 'x' + s.h + '@' + s.fpsWanted : null,
        output: s ? s.output : settings.output,
        outputs: Object.keys(OUTPUTS).map((k) => ({ id: k, title: OUTPUTS[k].title, ready: outputReady(k) })),
        pads: padList, canResume: !!settings.last && !s, last: settings.last ? { host: settings.last.host, app: settings.last.app } : null,
        error: s ? s.error : last.error || null, note: s ? null : last.note || null,
        hosts: hosts.map(hostView), pairing: pairing && pairing.state === 'waiting' || (pairing && Date.now() - pairing.started < 60000) ? pairing : null,
        settings: { mode: settings.mode, fps: settings.fps, bitrate: settings.bitrate, audio: settings.audio, volume: settings.volume, sops: settings.sops },
        modes: MODES.map((m) => m.id), rates: RATES,
    };
}

/* ---- the web page ------------------------------------------------------------ */

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
    const t = req.headers['x-moonlight-token'] || u.searchParams.get('t') || '';
    return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

/* The output: kept for the next play; while streaming, the picture moves
 * now (the game keeps running on the PC, so the stream is started again). */
function setOutput(id) {
    if (!OUTPUTS[id]) return Promise.reject(new Error('the centre console, the cluster or the HUD'));
    if (!outputReady(id)) return Promise.reject(new Error('the ' + OUTPUTS[id].title + ' is not available (' + (OUTPUTS[id].console ? 'mgu-render' : 'cluster-render') + ' is not connected)'));
    settings.output = id;
    saveSettings();
    const s = session;
    if (!s || s.output === id) return Promise.resolve(null);
    log('stream: moving to the ' + OUTPUTS[id].title);
    return new Promise((r) => stopSession('moved to the ' + OUTPUTS[id].title, r)).then(() => play(s.host.id, s.app.id)).then(() => null);
}

function setSettings(b) {
    if (b.mode && MODES.some((m) => m.id === b.mode)) settings.mode = b.mode;
    if (RATES.indexOf(Number(b.fps)) >= 0) settings.fps = Number(b.fps);
    if (b.bitrate !== undefined) settings.bitrate = Math.max(1000, Math.min(40000, Math.round(Number(b.bitrate) || 8000)));
    if (typeof b.audio === 'boolean') settings.audio = b.audio;
    if (b.volume !== undefined) settings.volume = Math.max(0, Math.min(150, Math.round(Number(b.volume) || 0)));
    if (typeof b.sops === 'boolean') settings.sops = b.sops;
    saveSettings();
}

/* The phone pad: buttons and axes as moonlight-core takes them. */
function phonePad(b) {
    if (!session) return 'nothing is streaming';
    const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    const line = b.off ? 'phonepad off\n' : 'phonepad ' + [n(b.b, 0, 0xffff), n(b.lt, 0, 255), n(b.rt, 0, 255),
        n(b.lx, -32768, 32767), n(b.ly, -32768, 32767), n(b.rx, -32768, 32767), n(b.ry, -32768, 32767)].join(' ') + '\n';
    try { session.core.stdin.write(line); } catch (e) { return 'the stream is ending'; }
    return null;
}

const ROUTES = {
    '/api/hosts/add': (b) => addHost(b.address).then(() => null),
    '/api/hosts/remove': (b) => { hosts = hosts.filter((h) => h.id !== b.id); saveHosts(); return Promise.resolve(null); },
    '/api/hosts/refresh': () => Promise.all(hosts.map((h) => refreshHost(h).then((x) => (x.paired ? client(x).appList().then((a) => { x.apps = a; }, () => null) : null))))
        .then(() => { saveHosts(); return null; }),
    '/api/pair': (b) => { const h = hostById(b.id); return h ? startPairing(h).then(() => null) : Promise.reject(new Error('no such PC')); },
    '/api/apps': (b) => {
        const h = hostById(b.id);
        if (!h) return Promise.reject(new Error('no such PC'));
        return client(h).appList().then((a) => { h.apps = a; saveHosts(); return null; });
    },
    '/api/play': (b) => play(b.id, b.app).then(() => null),
    '/api/stop': () => new Promise((r) => stopSession('stopped from the phone', () => r(null))),
    '/api/quit': () => quitGame().then(() => null),
    '/api/settings': (b) => { setSettings(b); return Promise.resolve(null); },
    '/api/output': (b) => setOutput(b.output),
    '/api/pad': (b) => { const e = phonePad(b); return e ? Promise.reject(new Error(e)) : Promise.resolve(null); },
    '/api/idr': () => { if (session) session.core.stdin.write('idr\n'); return Promise.resolve(null); },
};

const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!authorised(req, u)) return send(res, 403, 'text/plain', 'Scan the QR code on the iDrive Moonlight page to open this page.\n');
    if (!settings.enabled) return send(res, 503, 'text/plain', 'Moonlight is off: turn it on on the iDrive Moonlight page.\n');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, status());
    if (req.method !== 'POST' || !ROUTES[u.pathname]) return json(res, 404, { error: 'not found' });
    readBody(req, (err, b) => {
        if (err) return json(res, 400, { error: 'bad JSON' });
        ROUTES[u.pathname](b).then(() => json(res, 200, status()), (e) => json(res, 400, { error: e.message, status: status() }));
    });
});

/* ---- the iDrive app: on / off, stop, quit, resume ------------------------------ */

function setEnabled(on) {
    settings.enabled = on;
    saveSettings();
    if (on) { if (!NO_FIREWALL) { try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); } } }
    else {
        stopSession('turned off');
        if (!NO_FIREWALL) { try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); } }
    }
    log('moonlight: ' + (on ? 'on' : 'off'));
}

let control = null;
function command(c) {
    if (c.cmd === 'enable') { setEnabled(true); return null; }
    if (c.cmd === 'disable') { setEnabled(false); return null; }
    if (!settings.enabled) return 'Moonlight is off';
    if (c.cmd === 'stop') { stopSession('stopped on the iDrive page'); return null; }
    if (c.cmd === 'quit') { quitGame().catch((e) => { last = Object.assign({}, last, { error: e.message }); }).then(() => control && control.broadcast()); return null; }
    if (c.cmd === 'resume') {
        if (!settings.last) return 'nothing played yet: start a game from the phone first';
        if (session) return 'already streaming';
        play(settings.last.hostId, settings.last.appId).catch((e) => log('resume: ' + e.message)).then(() => control && control.broadcast());
        return null;
    }
    return 'unknown command';
}

/* ---- start and stop --------------------------------------------------------------- */

let stopping = false;
function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + ')');
    stopSession('shutting down');
    consoleVideo.stop();
    cr.close();
    if (!NO_FIREWALL) { try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); } }
    if (control) control.close();
    if (worker) worker.kill();
    web.close();
    setTimeout(() => process.exit(0), 800);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try { ID = identity(); } catch (e) { log('identity: ' + e.message + ' (pairing will not work)'); }
if (settings.enabled && !NO_FIREWALL) {
    try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); }
}
web.listen(PORT, '0.0.0.0', () => log('web: listening on port ' + PORT));
cr.on('ready', () => log('render: cluster-render connected (' + cr.backend + ')'));
cr.on('disconnected', () => log('render: cluster-render disconnected'));
cr.on('layer', (ref, state, reason) => log('render: layer ' + ref + ' ' + state + (reason ? ': ' + reason : '')));
cr.on('target', (t, state, holder, reason) => log('render: target ' + t + ' ' + state + (holder && holder !== 'none' ? ' (holder ' + holder + ')' : '') + (reason ? ': ' + reason : '')));
cr.on('refused', (op, ref, reason) => log('render: refused ' + op + ' ' + ref + (reason ? ': ' + reason : '')));
cr.connect();
control = startControl({ app: 'vizualyse_moonlight', status: status, command: command, log: log });
scanPads();
setInterval(scanPads, 5000);
/* the PCs' state (online, paired, a game running), for the page */
setInterval(() => { if (!session) hosts.forEach((h) => refreshHost(h)); }, 15000);
hosts.forEach((h) => refreshHost(h));
