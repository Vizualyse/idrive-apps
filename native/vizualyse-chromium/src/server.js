// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse-chromium: a web browser on the iDrive 7 head unit, WebGL 2 and
 * WebGPU included (on the CPU: SwiftShader; the GPU is off, see NET_UID) and
 * WebAssembly JSPI, on the central screen while parked. Controlled from a phone page (the address bar, back /
 * forward / reload, typing) and from the iDrive app (vizualyse_chromium:
 * show, hide, the page's link as a QR code, the GPU it got).
 *
 * - The bundle (chromium.tgz: Debian's Chromium 156 with its own glibc,
 *   tools/bundle.sh) is unpacked once into
 *   /var/opt/vizualyse-chromium/chromium (unpack.js).
 * - Chromium runs headless as the tool's uid 12997 (mgu-uplink routes it to
 *   the internet, through proxy.js and the phone's DNS), in its own group
 *   (never video: no GPU access), in a memory cgroup capped at MEM_MB, driven over
 *   DevTools on a pipe (browser.js). At each start probe() checks JSPI,
 *   WebGL 2 and WebGPU on a local page and saves what it found, chrome://gpu
 *   too, in STATE_DIR (gpu.json, gpu.txt) and the journal (@gpu).
 * - Shown: the page's screencast (JPEG) goes through chromium-sink into
 *   mgu-render's frame file, in the app area (screen.js); the display's
 *   touches inside it become the page's touches.
 * - Only while parked: the iDrive app sends the speed; above 3 km/h the page
 *   is hidden and can't be shown.
 *
 *   node server.js     (root: the renderer, the touch socket, nftables, the cgroup)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const env = require('./env.js');
const unpack = require('./unpack.js');
const { Browser } = require('./browser.js');
const { Screen } = require('./screen.js');
const firewall = require('./firewall.js');
const { startControl } = require('./control.js');

const HERE = __dirname;
const ARCHIVE = process.env.CHROMIUM_ARCHIVE || path.join(HERE, 'chromium.tgz');
const PORT = Number(process.env.CHROMIUM_PORT) || 8491;          /* the phone page, on the uplink's Wi-Fi */
const LOCAL_PORT = Number(process.env.CHROMIUM_LOCAL_PORT) || 8492;   /* 127.0.0.1: the probe's page, the start page */
const PROXY_PORT = Number(process.env.CHROMIUM_PROXY_PORT) || 8483;
const IFNAME = 'wlan0';
const LEASE = '/run/mgu-uplink/lease.json';
const UPLINK_STATUS = '/run/mgu-uplink/status.json';
const NO_FIREWALL = process.env.CHROMIUM_NO_FIREWALL === '1';
const NO_PROXY = process.env.CHROMIUM_NO_PROXY === '1';
/* The tool's uplink uid (component.json "uids"). Chromium runs in its own
 * group, NOT video (44, /dev/dri's): 0.1.1's Vulkan driver (Mesa 22.3 ANV)
 * hung in the kernel opening the GPU (i915_gem_context_open) and held the DRM
 * lock, so the HMI couldn't draw: a black screen and restarts on every boot
 * (2026-11-06). Without the group Chromium can't open the GPU at all. */
const NET_UID = Number(process.env.CHROMIUM_NET_UID) || 12997;
const CHROMIUM_GID = NET_UID;
/* The GPU mode only (turned on by hand, never at start): the render node's
 * group, for the unit's own Mesa 19 through the EGL shim (env.js). */
const VIDEO_GID = Number(process.env.CHROMIUM_VIDEO_GID) || 44;
/* Where the page goes: mgu-render's app area on the car (knowledge/central-screen.md) */
const VIEW = (function () {
    const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(process.env.CHROMIUM_VIEW || '1790x638+108+82');
    return { w: Number(m[1]) & ~1, h: Number(m[2]) & ~1, x: Number(m[3]), y: Number(m[4]) };
})();
const TOUCH_IFACE = process.env.CHROMIUM_TOUCH_IFACE !== undefined ? process.env.CHROMIUM_TOUCH_IFACE : 'vlan73';
const TOUCH_SRC = process.env.CHROMIUM_TOUCH_SRC || '160.48.199.115';
const TOUCH_FILE = process.env.CHROMIUM_TOUCH_FILE || '';
/* The memory cgroup (v1, mounted on the unit) and its cap: the unit has ~5.6 GB in all */
const CGROUP_ROOT = process.env.CHROMIUM_CGROUP_ROOT || '/sys/fs/cgroup/memory';
const MEM_MB = Number(process.env.CHROMIUM_MEM_MB) || 1536;
const MAX_KMH = 3;
const DEFAULT_URL = 'https://webglreport.com/?v=2';
const JPEG_QUALITY = 75;

const log = (s) => console.log(new Date().toISOString() + ' ' + s);

/* ---- small helpers ------------------------------------------------------- */

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(f, obj, mode) { unpack.mkdirp(path.dirname(f), 0o700); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1) + '\n', { mode: mode || 0o600 }); fs.renameSync(f + '.tmp', f); }

function token() {
    const f = path.join(env.STATE_DIR, 'token');
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{16}$/.test(t)) return t; } catch (e) { /* new */ }
    const t = crypto.randomBytes(8).toString('hex');
    unpack.mkdirp(env.STATE_DIR, 0o700);
    fs.writeFileSync(f, t + '\n', { mode: 0o600 });
    return t;
}

function uplinkIp() {
    const l = readJson(LEASE);
    if (l && l.ip) return l.ip;
    const ifs = os.networkInterfaces()[IFNAME] || [];
    const v4 = ifs.filter((a) => a.family === 'IPv4' && !a.internal)[0];
    return v4 ? v4.address : (process.env.CHROMIUM_LINK_IP || null);
}

/* The tool's folder: open to Chromium's uid (the bundle and its profile are
 * under it); the state in it stays root's. */
unpack.mkdirp(env.ROOT, 0o755);
try { fs.chmodSync(env.ROOT, 0o755); } catch (e) { /* not ours */ }
const TOKEN = token();
function link() { const ip = uplinkIp(); return ip ? 'http://' + ip + ':' + PORT + '/?t=' + TOKEN : null; }

/* What was typed into the address bar: a URL, a host name, or words to search. */
function toUrl(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    if (/^(https?|data|about|chrome):/i.test(t)) return t;
    if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(t) || /^localhost(:\d+)?(\/.*)?$/.test(t)) return 'https://' + t;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(t);
}

/* ---- settings ------------------------------------------------------------ */

const SETTINGS_FILE = path.join(env.STATE_DIR, 'settings.json');
const settings = Object.assign({ enabled: true, home: DEFAULT_URL, url: DEFAULT_URL }, readJson(SETTINGS_FILE) || {});
function saveSettings() { try { writeJson(SETTINGS_FILE, settings); } catch (e) { log('settings: ' + e.message); } }

/* ---- the memory cgroup ------------------------------------------------------- */

/* A memory cgroup for Chromium, capped, its cgroup.procs writable by the
 * browser's uid (it moves itself in before exec). null when there is none. */
function cgroup() {
    const dir = path.join(CGROUP_ROOT, 'vizualyse-chromium');
    try {
        if (!fs.existsSync(CGROUP_ROOT)) return null;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'memory.limit_in_bytes'), String(MEM_MB * 1024 * 1024));
        fs.chownSync(path.join(dir, 'cgroup.procs'), NET_UID, CHROMIUM_GID);
        return dir;
    } catch (e) {
        log('cgroup: ' + e.message + ' (Chromium runs without a memory cap)');
        return null;
    }
}

/* ---- the proxy ------------------------------------------------------------ */

let proxy = null;
function startProxy() {
    if (NO_PROXY || proxy) return;
    proxy = spawn(process.execPath, [path.join(HERE, 'proxy.js'), String(PROXY_PORT)], { uid: NET_UID, gid: NET_UID, stdio: ['ignore', 'pipe', 'pipe'] });
    proxy.stdout.on('data', (d) => process.stdout.write(d));
    proxy.stderr.on('data', (d) => process.stderr.write(d));
    proxy.on('exit', (code, sig) => {
        log('proxy: exited (' + (sig || code) + ')');
        proxy = null;
        if (!stopping) setTimeout(startProxy, 3000);
    });
}

/* ---- the local page (127.0.0.1): the probe's secure context ---------------------- */

const local = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><title>vizualyse-chromium</title><body style="background:#000;color:#ccc;font:24px sans-serif">vizualyse-chromium</body>');
});

/* ---- the browser ------------------------------------------------------------- */

const vehicle = { kmh: null, at: 0 };
function moving() { return vehicle.kmh !== null && vehicle.kmh > MAX_KMH && Date.now() - vehicle.at < 10000; }

let bundle = { state: 'checking' };       /* checking | unpacking | ready | failed */
let browser = null;
let browserState = 'off';                 /* off | starting | running | crashed */
let restarts = [];                        /* the times of recent unplanned exits */
let gpu = readJson(path.join(env.STATE_DIR, 'gpu.json'));
let lastError = null;
let stats = { pictures: 0, decodeMs: 0 };
const screen = new Screen(log, path.join(env.BUNDLE, 'chromium-sink'));
let wantShown = false;

/* ---- the GPU mode ------------------------------------------------------------ */

/* WebGL on the unit's own GPU driver (Mesa 19, i965: env.js). Experimental:
 * a GPU driver of our own (0.1.1) hung the kernel and blacked out the HMI,
 * and every boot started it again. So the GPU mode:
 * - is turned on by hand only (the phone page, the iDrive app) and is never
 *   kept: every start of the tool is on the CPU, so a hang can't loop;
 * - leaves GPU_TRIAL while a GPU-mode Chromium runs, removed when it exits:
 *   found at start, it means the last try never ended (the unit restarted),
 *   and the app says so;
 * - goes back to the CPU by itself when the probe finds no GPU renderer or
 *   Chromium exits in it. */
const GPU_TRIAL = path.join(env.STATE_DIR, 'gpu-trial');
let gpuMode = false;
let gpuNote = null;
(function () {
    const t = readJson(GPU_TRIAL);
    if (!t) return;
    gpuNote = 'the last GPU try (' + (t.at || '?') + ') never ended: the unit restarted. GPU mode is off';
    log('gpu: ' + gpuNote);
    try { fs.unlinkSync(GPU_TRIAL); } catch (e) { /* gone */ }
})();

/* WebGL 2's renderer from the unit's Mesa (not SwiftShader) */
function onGpu(p) { const r = String((p && p.webgl2) || ''); return /Mesa|Intel/i.test(r) && !/SwiftShader|llvmpipe|softpipe/i.test(r); }

function setGpu(on, why) {
    on = !!on;
    if (on === gpuMode) return null;
    if (on && !settings.enabled) return 'the browser is off';
    if (on && bundle.state !== 'ready') return 'the browser is not installed yet';
    if (on) {
        let missing;
        try { missing = env.gpuLibs(); } catch (e) { return 'the GPU libraries: ' + e.message; }
        if (missing.length) return 'this unit has no ' + missing.join(', ');
        gpuNote = null;
    }
    gpuMode = on;
    log('gpu: ' + (on ? 'on: Chromium restarts on the unit\'s own GPU driver (Mesa 19, i965); off again at the next start of the tool'
        : 'off' + (why ? ' (' + why + ')' : '')));
    restarts = [];
    lastError = null;
    stopBrowser();
    setTimeout(startBrowser, 1500);
    if (control) control.broadcast();
    return null;
}

function startBrowser() {
    if (browser || bundle.state !== 'ready' || !settings.enabled || stopping) return;
    startProxy();
    const useGpu = gpuMode;
    if (useGpu) {
        try { writeJson(GPU_TRIAL, { at: new Date().toISOString() }); } catch (e) { log('gpu: ' + e.message); }
    }
    const b = new Browser({ w: VIEW.w, h: VIEW.h, uid: NET_UID, gid: useGpu ? VIDEO_GID : CHROMIUM_GID, gpu: useGpu,
        proxy: NO_PROXY ? 0 : PROXY_PORT, cgroup: cgroup(), url: 'about:blank' });
    browser = b;
    browserState = 'starting';
    let quiet = 0;
    b.on('log', (l) => {
        /* Chromium's own lines: D-Bus and the like are expected here; keep the journal readable */
        if (/dbus|GLib-GIO|UPower|crashpad|scaling_(cur|max)_freq/.test(l)) { quiet++; return; }
        log('chromium: ' + l.slice(0, 400));
    });
    b.on('navigated', (n) => {
        log('page: ' + n.url + (n.title ? ' "' + n.title.slice(0, 80) + '"' : ''));
        if (/^https?:/.test(n.url) && n.url !== settings.url) { settings.url = n.url; saveSettings(); }
        if (control) control.broadcast();
    });
    b.on('frame', (jpeg, meta, ack) => {
        stats.pictures++;
        screen.picture(jpeg, ack);
    });
    b.on('exit', (code, sig) => {
        log('chromium: exited (' + (sig || code) + ')' + (quiet ? ', ' + quiet + ' quiet lines' : ''));
        /* it ended: no hang in the kernel */
        if (useGpu) { try { fs.unlinkSync(GPU_TRIAL); } catch (e) { /* gone */ } }
        if (browser !== b) return;
        browser = null;
        hide('the browser exited');
        if (stopping || !settings.enabled) { browserState = 'off'; return; }
        if (useGpu && gpuMode) {
            gpuNote = 'Chromium exited in GPU mode (' + (sig || code) + '): back on the CPU';
            setGpu(false, 'Chromium exited');
            return;
        }
        browserState = 'crashed';
        const now = Date.now();
        restarts = restarts.filter((t) => now - t < 300000).concat(now);
        if (restarts.length > 5) {
            lastError = 'Chromium exited ' + restarts.length + ' times in 5 minutes: not restarted (turn it off and on)';
            log('chromium: ' + lastError);
            return;
        }
        setTimeout(startBrowser, 3000 * restarts.length);
    });
    const t0 = Date.now();
    b.start()
        .then(() => {
            log('chromium: running (' + (Date.now() - t0) + ' ms), ' + VIEW.w + 'x' + VIEW.h + ', ' +
                (useGpu ? 'GPU mode: ANGLE on the unit\'s Mesa 19 (OpenGL ES, i965)' : 'Vulkan on the CPU (SwiftShader)'));
            browserState = 'running';
            lastError = null;
            return b.probe('http://127.0.0.1:' + LOCAL_PORT + '/probe').then((p) => {
                const page = p.gpuPage;
                delete p.gpuPage;
                gpu = Object.assign({ at: new Date().toISOString(), mode: useGpu ? 'gpu' : 'cpu' }, p);
                console.log('@gpu ' + JSON.stringify(gpu));
                try {
                    writeJson(path.join(env.STATE_DIR, 'gpu.json'), gpu, 0o644);
                    if (page) fs.writeFileSync(path.join(env.STATE_DIR, 'gpu.txt'), page + '\n', { mode: 0o644 });
                } catch (e) { log('gpu: ' + e.message); }
                if (useGpu && browser === b) {
                    if (onGpu(p)) { log('gpu: WebGL 2 on the GPU: ' + p.webgl2); return; }
                    gpuNote = 'the GPU did not start (WebGL 2: ' + String(p.webgl2 || 'none').slice(0, 60) + '): back on the CPU; chrome://gpu has why';
                    log('gpu: ' + gpuNote);
                    setGpu(false, 'no GPU renderer');
                }
            }, (e) => log('probe: ' + e.message));
        })
        .then(() => (browser === b ? b.navigate(settings.url || settings.home) : null))
        .then(() => {
            if (wantShown && browser === b) show();
            if (control) control.broadcast();
        })
        .catch((e) => {
            lastError = 'Chromium: ' + e.message;
            log('chromium: ' + e.message);
            if (browser === b) b.stop();
        });
}

function stopBrowser() {
    hide('the browser is off');
    if (browser) { const b = browser; browser = null; browserState = 'off'; b.stop(); }
}

/* ---- on the screen ----------------------------------------------------------- */

let touchDown = false;
screen.on('touch', (e) => {
    if (!browser || !screen.shown()) return;
    const x = e.x - VIEW.x, y = e.y - VIEW.y;
    const inside = x >= 0 && y >= 0 && x < VIEW.w && y < VIEW.h;
    if (e.p === 1) {
        /* touches that start outside are the HMI's (its bar, its back arrow) */
        if (!inside) return;
        touchDown = true;
    } else if (!touchDown) {
        return;
    }
    if (e.p === 3) touchDown = false;
    const cx = Math.max(0, Math.min(VIEW.w - 1, x)), cy = Math.max(0, Math.min(VIEW.h - 1, y));
    browser.touch(e.p, cx, cy).catch((err) => log('touch: ' + err.message));
});
screen.on('stats', (e) => { stats.decodeMs = e.ms; });
screen.on('sink-error', (e) => log('sink: ' + e.error));
screen.on('ready', (e) => log('sink: ready ' + e.w + 'x' + e.h + ', touch ' + e.touch + ', uid ' + e.uid));
screen.on('gone', () => { if (wantShown && !stopping) { log('screen: the sink went away; hidden'); hide('the sink exited'); } });

function show() {
    wantShown = true;
    if (moving()) { wantShown = false; return 'not while driving'; }
    if (!browser || browserState !== 'running') return null;   /* shown once it runs */
    if (screen.shown()) return null;
    const touch = TOUCH_FILE ? { file: TOUCH_FILE } : TOUCH_IFACE ? { iface: TOUCH_IFACE, src: TOUCH_SRC } : null;
    screen.show(VIEW, touch);
    browser.screencast(true, JPEG_QUALITY).catch((e) => log('screencast: ' + e.message));
    log('screen: shown');
    return null;
}

function hide(why) {
    wantShown = false;
    touchDown = false;
    if (browser) browser.screencast(false).catch(() => { /* gone */ });
    if (screen.shown()) { screen.hide(); log('screen: hidden (' + why + ')'); }
}

function setSpeed(kmh) {
    const v = Number(kmh);
    vehicle.kmh = isFinite(v) ? v : null;
    vehicle.at = Date.now();
    if (moving() && (wantShown || screen.shown())) hide('driving (' + v.toFixed(0) + ' km/h)');
}

/* ---- status ------------------------------------------------------------------ */

function gpuSummary() {
    if (!gpu) return null;
    return { mode: gpu.mode || 'cpu', webgpu: gpu.webgpu, webgpuFallback: !!gpu.webgpuFallback, webgpuCompute: gpu.webgpuCompute, webgl2: gpu.webgl2, jspi: gpu.jspi, at: gpu.at };
}

function status() {
    const up = readJson(UPLINK_STATUS) || {};
    return {
        enabled: settings.enabled, link: link(), uplink: up.state || 'unknown',
        bundle: bundle.state, browser: browserState, shown: screen.shown(),
        url: browser ? browser.url : settings.url, title: browser ? browser.title : '', home: settings.home,
        gpu: gpuSummary(), gpuMode: gpuMode, gpuNote: gpuNote, speed: vehicle.kmh, moving: moving(),
        pictures: stats.pictures, decodeMs: stats.decodeMs,
        view: VIEW.w + 'x' + VIEW.h, error: lastError || bundle.error || null,
    };
}

/* ---- the phone page ------------------------------------------------------------- */

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
    const t = req.headers['x-chromium-token'] || u.searchParams.get('t') || '';
    return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}
function need() { return browser && browserState === 'running' ? Promise.resolve(browser) : Promise.reject(new Error('the browser is not running')); }

const ROUTES = {
    '/api/go': (b) => { const url = toUrl(b.url); return url ? need().then((x) => x.navigate(url)) : Promise.reject(new Error('type an address')); },
    '/api/back': () => need().then((x) => x.history(-1)),
    '/api/forward': () => need().then((x) => x.history(1)),
    '/api/reload': () => need().then((x) => x.reload()),
    '/api/home': () => need().then((x) => x.navigate(settings.home)),
    '/api/sethome': () => { if (browser && /^https?:/.test(browser.url)) { settings.home = browser.url; saveSettings(); } return Promise.resolve(); },
    '/api/show': () => { const e = show(); return e ? Promise.reject(new Error(e)) : Promise.resolve(); },
    '/api/hide': () => { hide('hidden from the phone'); return Promise.resolve(); },
    '/api/text': (b) => need().then((x) => x.text(String(b.text || '').slice(0, 2000))),
    '/api/key': (b) => need().then((x) => x.key(String(b.key || ''))),
    '/api/probe': () => need().then((x) => x.probe('http://127.0.0.1:' + LOCAL_PORT + '/probe')).then((p) => { delete p.gpuPage; gpu = Object.assign({ at: new Date().toISOString() }, p); console.log('@gpu ' + JSON.stringify(gpu)); }),
    '/api/gpu': (b) => { const e = setGpu(!!b.on); return e ? Promise.reject(new Error(e)) : Promise.resolve(); },
    '/api/restart': () => { restarts = []; lastError = null; stopBrowser(); setTimeout(startBrowser, 1500); return Promise.resolve(); },
};

const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!authorised(req, u)) return send(res, 403, 'text/plain', 'Scan the QR code on the iDrive Browser page to open this page.\n');
    if (!settings.enabled) return send(res, 503, 'text/plain', 'The browser is off: turn it on on the iDrive Browser page.\n');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, status());
    if (req.method === 'GET' && u.pathname === '/api/gpu.txt') {
        let t = '';
        try { t = fs.readFileSync(path.join(env.STATE_DIR, 'gpu.txt'), 'utf8'); } catch (e) { t = 'not probed yet\n'; }
        return send(res, 200, 'text/plain; charset=utf-8', t);
    }
    if (req.method !== 'POST' || !ROUTES[u.pathname]) return json(res, 404, { error: 'not found' });
    readBody(req, (err, b) => {
        if (err) return json(res, 400, { error: 'bad JSON' });
        ROUTES[u.pathname](b).then(() => json(res, 200, status()), (e) => json(res, 400, { error: e.message, status: status() }));
    });
});

/* ---- the iDrive app -------------------------------------------------------------- */

function addFirewall() {
    if (NO_FIREWALL) return;
    try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); }
}
function removeFirewall() {
    if (NO_FIREWALL) return;
    try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); }
}

function setEnabled(on) {
    if (settings.enabled === on) return;
    settings.enabled = on;
    saveSettings();
    if (on) { addFirewall(); restarts = []; lastError = null; startBrowser(); } else { gpuMode = false; stopBrowser(); removeFirewall(); }
    log('browser: ' + (on ? 'on' : 'off'));
}

let control = null;
function command(c) {
    if (c.cmd === 'speed') { setSpeed(c.kmh); return null; }
    if (c.cmd === 'enable') { setEnabled(true); return null; }
    if (c.cmd === 'disable') { setEnabled(false); return null; }
    if (!settings.enabled) return 'the browser is off';
    if (c.cmd === 'show') return show();
    if (c.cmd === 'hide') { hide('hidden on the iDrive page'); return null; }
    if (c.cmd === 'gpu') return setGpu(!!c.on);
    if (!browser || browserState !== 'running') return 'the browser is not running';
    if (c.cmd === 'home') { browser.navigate(settings.home).catch((e) => log('home: ' + e.message)); return null; }
    if (c.cmd === 'reload') { browser.reload().catch((e) => log('reload: ' + e.message)); return null; }
    if (c.cmd === 'back') { browser.history(-1).catch((e) => log('back: ' + e.message)); return null; }
    return 'unknown command';
}

/* ---- start and stop ------------------------------------------------------------- */

let stopping = false;
function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + ')');
    stopBrowser();
    removeFirewall();
    if (control) control.close();
    if (proxy) proxy.kill('SIGTERM');
    web.close();
    local.close();
    setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (settings.enabled) addFirewall();
web.listen(PORT, '0.0.0.0', () => log('web: listening on port ' + PORT));
local.listen(LOCAL_PORT, '127.0.0.1');
control = startControl({ app: 'vizualyse_chromium', status: status, command: command, log: log });
setInterval(() => { if (browser && browserState === 'running') browser.refreshTitle(false); }, 2000);

bundle = { state: 'unpacking' };
unpack.ensure(ARCHIVE, log, (err, r) => {
    if (err) {
        bundle = { state: 'failed', error: 'the bundle: ' + err.message };
        log('bundle: ' + err.message);
        return;
    }
    bundle = { state: 'ready' };
    try { log('bundle: ' + fs.readFileSync(path.join(env.BUNDLE, 'VERSION'), 'utf8').split('\n').slice(1, 4).join(', ')); } catch (e) { /* old */ }
    if (!r.unpacked) log('bundle: up to date');
    startBrowser();
});
